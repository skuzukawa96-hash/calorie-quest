/**
 * A green pencil, the icon of writing (記入問題, 記入式), drawn here because the ✏️ emoji comes out
 * red on Windows, while a pencil in Japan is green more often than not.
 */
export default function PencilIcon() {
  return (
    <svg className="pencil-icon" viewBox="0 0 24 24" width="1.15em" height="1.15em" aria-hidden="true">
      <g transform="rotate(45 12 12)">
        <rect x="9" y="1.5" width="6" height="16" rx="1" fill="#3f9a5c" />
        <rect x="11.1" y="1.5" width="1.8" height="16" fill="#62bb7c" />
        <rect x="9" y="1.5" width="6" height="1.6" rx="0.8" fill="#2f7a47" />
        <path d="M9 17.5 L15 17.5 L12 22.5 Z" fill="#f1d3a4" />
        <path d="M10.9 20.7 L13.1 20.7 L12 22.5 Z" fill="#3b2a1e" />
      </g>
    </svg>
  );
}
