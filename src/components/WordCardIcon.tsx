/**
 * 単語カード as a Japanese learner knows it: a stack of small cards held by a ring through a hole
 * in their corner. Drawn here because no emoji is one (🃏 is a joker, 📇 a card index).
 */
export default function WordCardIcon() {
  return (
    <svg className="word-card-icon" viewBox="0 0 24 24" width="1.2em" height="1.2em" aria-hidden="true">
      {/* the card behind, turned a little */}
      <g transform="rotate(-12 13 11)">
        <rect x="6.5" y="4.5" width="15" height="10" rx="1.6" fill="#cfe5f7" stroke="#6f9fc9" strokeWidth="1.1" />
      </g>
      {/* the card in front, with two lines of writing */}
      <rect x="3" y="8.5" width="15.5" height="10.5" rx="1.6" fill="#fff8de" stroke="#c99a3a" strokeWidth="1.1" />
      <path d="M8.5 12.6h7M8.5 15.4h4.6" stroke="#c99a3a" strokeWidth="1.3" strokeLinecap="round" />
      {/* the hole and the ring through it */}
      <circle cx="5.6" cy="11.2" r="0.95" fill="#8b6f4e" />
      <ellipse cx="5.2" cy="9.4" rx="2.3" ry="2.9" fill="none" stroke="#8d939c" strokeWidth="1.3" />
    </svg>
  );
}
