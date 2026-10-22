package com.caloriequest.app

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@InvokeArg
class SynthesizeArgs {
    var texts: List<String> = emptyList()
    /** 1.0 is the voice's own speed */
    var rate: Float = 1.0f
}

@InvokeArg
class ListenArgs {
    var lang: String = "en-US"
    var timeoutSecs: Int = 6
}

/**
 * The phone's own text-to-speech and speech recognizer, for speech.rs: Android's WebView has neither
 * part of the Web Speech API. The commands answer from callbacks or a thread of their own and never
 * hold up the thread they are called on.
 */
@TauriPlugin(permissions = [Permission(strings = [Manifest.permission.RECORD_AUDIO], alias = "microphone")])
class SpeechPlugin(private val activity: Activity) : Plugin(activity) {
    private val main = Handler(Looper.getMainLooper())

    /* ---------- text to speech ---------- */

    private val ttsLock = Any()
    /** the engine, once it is set up for American English */
    @Volatile private var tts: TextToSpeech? = null
    /** opens when the engine being started is set up, or has failed; null when none is starting or running (ttsLock) */
    private var ttsReady: CountDownLatch? = null
    @Volatile private var ttsVoices: List<String> = emptyList()
    /** what each utterance being made into a file is waited on by: true when it is made */
    private val making = ConcurrentHashMap<String, (Boolean) -> Unit>()

    /**
     * The engine's start, begun if it is neither running nor starting: the latch opens once it is set
     * up for American English, or has failed, in which case the next call starts it again.
     */
    private fun startTts(): CountDownLatch = synchronized(ttsLock) {
        ttsReady ?: CountDownLatch(1).also { ready ->
            ttsReady = ready
            main.post {
                var engine: TextToSpeech? = null
                engine = TextToSpeech(activity.applicationContext) { status ->
                    val started = engine
                    val voices = if (status == TextToSpeech.SUCCESS && started != null) setUpVoice(started) else emptyList()
                    synchronized(ttsLock) {
                        ttsVoices = voices
                        if (voices.isEmpty()) {
                            started?.shutdown()
                            ttsReady = null
                        } else {
                            tts = started
                        }
                    }
                    ready.countDown()
                }
                // No engine at all fails inside the constructor, before `engine` is set.
                if (ready.count == 0L && tts !== engine) engine.shutdown()
            }
        }
    }

    /** American English, in the best voice on the phone itself (one that needs no network). */
    private fun setUpVoice(t: TextToSpeech): List<String> {
        val lang = t.setLanguage(Locale.US)
        if (lang == TextToSpeech.LANG_MISSING_DATA || lang == TextToSpeech.LANG_NOT_SUPPORTED) return emptyList()
        val english = t.voices.orEmpty().filter {
            it.locale.language == "en" &&
                it.locale.country == "US" &&
                !it.isNetworkConnectionRequired &&
                !it.features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)
        }
        english.maxByOrNull { it.quality }?.let { t.setVoice(it) }
        t.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String) {}
            override fun onDone(utteranceId: String) {
                making.remove(utteranceId)?.invoke(true)
            }
            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String) {
                making.remove(utteranceId)?.invoke(false)
            }
            override fun onError(utteranceId: String, errorCode: Int) {
                making.remove(utteranceId)?.invoke(false)
            }
        })
        return listOf(t.voice?.name ?: "en-US") + english.map { it.name }.filter { it != t.voice?.name }
    }

    @Command
    fun capabilities(invoke: Invoke) {
        val ready = startTts()
        Thread {
            ready.await(TTS_START_SECS, TimeUnit.SECONDS)
            val recognizer = SpeechRecognizer.isRecognitionAvailable(activity)
            val out = JSObject()
            out.put("voices", JSONArray(ttsVoices))
            out.put("recognizer", recognizer)
            out.put(
                "error",
                when {
                    ttsVoices.isEmpty() -> "英語の音声合成がありません（設定 → システム → 言語 → テキスト読み上げ）"
                    !recognizer -> "音声認識のアプリがありません"
                    else -> JSONObject.NULL
                },
            )
            invoke.resolve(out)
        }.start()
    }

    /** A WAV file in the cache for each text, in order; speech.rs reads and deletes them. */
    @Command
    fun synthesize(invoke: Invoke) {
        val args = invoke.parseArgs(SynthesizeArgs::class.java)
        val ready = startTts()
        Thread {
            ready.await(TTS_START_SECS, TimeUnit.SECONDS)
            val t = tts
            if (t == null) {
                invoke.reject("英語の音声合成が使えません")
                return@Thread
            }
            val files = args.texts.map { File.createTempFile("say", ".wav", activity.cacheDir) }
            val ids = files.map { UUID.randomUUID().toString() }
            val made = CountDownLatch(files.size)
            var failed = false
            t.setSpeechRate(args.rate)
            for ((i, text) in args.texts.withIndex()) {
                making[ids[i]] = { ok ->
                    if (!ok) failed = true
                    made.countDown()
                }
                if (t.synthesizeToFile(text, Bundle(), files[i], ids[i]) != TextToSpeech.SUCCESS) {
                    making.remove(ids[i])
                    failed = true
                    made.countDown()
                }
            }
            if (!made.await(20, TimeUnit.SECONDS) || failed) {
                // An utterance the engine finishes after this deletes its file, rather than leave it in the cache.
                ids.zip(files).forEach { (id, file) -> making.replace(id) { _ -> file.delete() } }
                files.forEach { it.delete() }
                invoke.reject("音声を作れませんでした")
                return@Thread
            }
            val out = JSObject()
            out.put("paths", JSONArray(files.map { it.absolutePath }))
            invoke.resolve(out)
        }.start()
    }

    /* ---------- speech recognition ---------- */

    private var recognizer: SpeechRecognizer? = null
    private val heardLock = Any()
    /** what the last listening made out, kept until "heard" asks for it */
    private var outcome: JSObject? = null
    /** a "heard" asked before the listening was over */
    private var waiting: Invoke? = null

    /** Answers once the recognizer is ready for speech, after asking for the microphone the first time. */
    @Command
    fun listen(invoke: Invoke) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", invoke, "microphoneAnswered")
            return
        }
        startListening(invoke)
    }

    @PermissionCallback
    private fun microphoneAnswered(invoke: Invoke) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) startListening(invoke)
        else invoke.reject("not-allowed")
    }

    /** What the listening "listen" started made out: its guesses, the best first, or what went wrong. */
    @Command
    fun heard(invoke: Invoke) {
        synchronized(heardLock) {
            val done = outcome
            if (done != null) {
                outcome = null
                invoke.resolve(done)
            } else {
                waiting = invoke
            }
        }
    }

    private fun startListening(invoke: Invoke) {
        val args = invoke.parseArgs(ListenArgs::class.java)
        synchronized(heardLock) {
            outcome = null
            // a "heard" still waiting on the listening this one replaces: answered, not left hanging
            waiting?.resolve(heardOf(emptyList(), null, false, "aborted", 0))
            waiting = null
        }
        main.post {
            recognizer?.destroy()
            val r = SpeechRecognizer.createSpeechRecognizer(activity)
            recognizer = r
            // Everything below runs on the main thread: the listener's calls and the deadlines.
            var ready: Invoke? = invoke
            var heard = false
            var settled = false
            var began = 0L
            var ended = 0L
            val deadlines = mutableListOf<Runnable>()
            fun after(ms: Long, then: () -> Unit) {
                val task = Runnable { then() }
                deadlines += task
                main.postDelayed(task, ms)
            }
            fun letGo() {
                settled = true
                deadlines.forEach { main.removeCallbacks(it) }
            }
            /** The listening over, whichever way it ended: told to "heard", once. */
            fun done(texts: List<String>, sure: FloatArray?, error: String?) {
                if (settled) return
                letGo()
                finish(r, texts, sure, heard, error, spoken(began, ended))
            }
            /** It never got as far as listening: the "listen" call fails. */
            fun failToStart(error: String) {
                val before = ready ?: return
                ready = null
                letGo()
                r.destroy()
                if (recognizer === r) recognizer = null
                before.reject(error)
            }
            // The recognizer's service never answering is taken as a failure to reach it.
            after(READY_LIMIT_MS) { failToStart("network") }
            r.setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) {
                    if (settled) return
                    ready?.resolve()
                    ready = null
                    // No speech by then: given up on, as the Windows recognizer's initial silence ends it.
                    after(args.timeoutSecs * 1000L) {
                        if (!heard) {
                            r.cancel()
                            done(emptyList(), null, "no-speech")
                        }
                    }
                }
                override fun onBeginningOfSpeech() {
                    heard = true
                    began = SystemClock.elapsedRealtime()
                    // Speech going on with no result (the service stalled, the app sent to the back):
                    // given up on as not made out, as the Windows recognizer's babble timeout ends it.
                    after(SPEECH_LIMIT_MS) {
                        ended = SystemClock.elapsedRealtime()
                        r.cancel()
                        done(emptyList(), null, "no-match")
                    }
                }
                override fun onEndOfSpeech() {
                    ended = SystemClock.elapsedRealtime()
                }
                override fun onResults(results: Bundle?) {
                    val texts = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).orEmpty()
                    val sure = results?.getFloatArray(SpeechRecognizer.CONFIDENCE_SCORES)
                    done(texts, sure, if (texts.isEmpty()) "no-match" else null)
                }
                override fun onError(error: Int) {
                    if (ready != null) failToStart(errorName(error)) else done(emptyList(), null, errorName(error))
                }
                override fun onRmsChanged(rmsdB: Float) {}
                override fun onBufferReceived(buffer: ByteArray?) {}
                override fun onPartialResults(partialResults: Bundle?) {}
                override fun onEvent(eventType: Int, params: Bundle?) {}
            })
            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, args.lang)
                putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 5)
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
                putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, activity.packageName)
                // A short pause inside a longer sentence must not end it (as on Windows).
                putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1200L)
            }
            r.startListening(intent)
        }
    }

    private fun spoken(began: Long, ended: Long) = if (began > 0 && ended > began) ended - began else 0L

    /** What "heard" answers: the guesses, the best first, and how sure of each; or what went wrong. */
    private fun heardOf(texts: List<String>, sure: FloatArray?, heard: Boolean, error: String?, durationMs: Long): JSObject {
        val out = JSObject()
        out.put("transcripts", JSONArray(texts))
        out.put("confidences", JSONArray(texts.indices.map { (sure?.getOrNull(it) ?: 0f).toDouble() }))
        out.put("heard", heard)
        out.put("error", error ?: JSONObject.NULL)
        out.put("durationMs", durationMs)
        return out
    }

    /** Hands what was made out to "heard" (now, or when it asks) and lets the recognizer go. */
    private fun finish(r: SpeechRecognizer, texts: List<String>, sure: FloatArray?, heard: Boolean, error: String?, durationMs: Long) {
        val out = heardOf(texts, sure, heard, error, durationMs)
        synchronized(heardLock) {
            val asked = waiting
            if (asked != null) {
                waiting = null
                asked.resolve(out)
            } else {
                outcome = out
            }
        }
        main.post {
            r.destroy()
            if (recognizer === r) recognizer = null
        }
    }

    /** Android's errors by the Web Speech API's names, which the frontend explains. */
    private fun errorName(error: Int) = when (error) {
        SpeechRecognizer.ERROR_NO_MATCH -> "no-match"
        SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "no-speech"
        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT, SpeechRecognizer.ERROR_SERVER -> "network"
        SpeechRecognizer.ERROR_AUDIO -> "audio-capture"
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "not-allowed"
        SpeechRecognizer.ERROR_CLIENT -> "aborted"
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "busy"
        else -> "error-$error"
    }

    private companion object {
        /** how long a call waits for the engine to start: binding to it can be slow just after the phone starts */
        const val TTS_START_SECS = 20L
        /** how long the recognizer's service may take to be ready to listen */
        const val READY_LIMIT_MS = 10_000L
        /** how long speech may go on with no result */
        const val SPEECH_LIMIT_MS = 15_000L
    }
}
