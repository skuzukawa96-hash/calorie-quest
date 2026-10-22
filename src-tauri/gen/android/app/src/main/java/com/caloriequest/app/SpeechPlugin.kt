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

    private var tts: TextToSpeech? = null
    private val ttsReady = CountDownLatch(1)
    @Volatile private var ttsVoices: List<String> = emptyList()
    /** what each utterance being made into a file is waited on by: true when it is made */
    private val making = ConcurrentHashMap<String, (Boolean) -> Unit>()

    /** Starts the engine once; ttsReady opens when it is set up for American English (or failed). */
    private fun startTts() {
        main.post {
            if (tts != null) return@post
            tts = TextToSpeech(activity.applicationContext) { status ->
                if (status == TextToSpeech.SUCCESS) ttsVoices = setUpVoice()
                ttsReady.countDown()
            }
        }
    }

    /** American English, in the best voice on the phone itself (one that needs no network). */
    private fun setUpVoice(): List<String> {
        val t = tts ?: return emptyList()
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
        startTts()
        Thread {
            ttsReady.await(5, TimeUnit.SECONDS)
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
        startTts()
        Thread {
            val t = tts
            if (!ttsReady.await(5, TimeUnit.SECONDS) || t == null || ttsVoices.isEmpty()) {
                invoke.reject("英語の音声合成が使えません")
                return@Thread
            }
            val files = args.texts.map { File.createTempFile("say", ".wav", activity.cacheDir) }
            val made = CountDownLatch(files.size)
            var failed = false
            t.setSpeechRate(args.rate)
            args.texts.zip(files).forEach { (text, file) ->
                val id = UUID.randomUUID().toString()
                making[id] = { ok ->
                    if (!ok) failed = true
                    made.countDown()
                }
                if (t.synthesizeToFile(text, Bundle(), file, id) != TextToSpeech.SUCCESS) {
                    making.remove(id)
                    failed = true
                    made.countDown()
                }
            }
            if (!made.await(20, TimeUnit.SECONDS) || failed) {
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
            waiting = null
        }
        main.post {
            recognizer?.destroy()
            val r = SpeechRecognizer.createSpeechRecognizer(activity)
            recognizer = r
            var ready: Invoke? = invoke
            var heard = false
            var began = 0L
            var ended = 0L
            // No speech by then: given up on, as the Windows recognizer's initial silence ends it.
            val silence = Runnable {
                if (!heard) {
                    r.cancel()
                    finish(r, emptyList(), null, false, "no-speech", 0)
                }
            }
            r.setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) {
                    ready?.resolve()
                    ready = null
                    main.postDelayed(silence, args.timeoutSecs * 1000L)
                }
                override fun onBeginningOfSpeech() {
                    heard = true
                    began = SystemClock.elapsedRealtime()
                }
                override fun onEndOfSpeech() {
                    ended = SystemClock.elapsedRealtime()
                }
                override fun onResults(results: Bundle?) {
                    main.removeCallbacks(silence)
                    val texts = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).orEmpty()
                    val sure = results?.getFloatArray(SpeechRecognizer.CONFIDENCE_SCORES)
                    finish(r, texts, sure, heard, if (texts.isEmpty()) "no-match" else null, spoken(began, ended))
                }
                override fun onError(error: Int) {
                    main.removeCallbacks(silence)
                    val name = errorName(error)
                    val before = ready
                    if (before != null) {
                        // It never got as far as listening: the "listen" call fails.
                        ready = null
                        r.destroy()
                        if (recognizer === r) recognizer = null
                        before.reject(name)
                        return
                    }
                    finish(r, emptyList(), null, heard, name, spoken(began, ended))
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

    /** Hands what was made out to "heard" (now, or when it asks) and lets the recognizer go. */
    private fun finish(r: SpeechRecognizer, texts: List<String>, sure: FloatArray?, heard: Boolean, error: String?, durationMs: Long) {
        val out = JSObject()
        out.put("transcripts", JSONArray(texts))
        out.put("confidences", JSONArray(texts.indices.map { (sure?.getOrNull(it) ?: 0f).toDouble() }))
        out.put("heard", heard)
        out.put("error", error ?: JSONObject.NULL)
        out.put("durationMs", durationMs)
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
}
