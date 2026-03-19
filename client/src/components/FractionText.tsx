import type { ReactNode } from 'react';

const FRACTION_RE = /\{([^}]+)\/([^}]+)\}/g;

function InlineFraction({ numerator, denominator }: { numerator: string; denominator: string }) {
  return (
    <svg
      style={{ display: 'inline-block', verticalAlign: 'middle', width: '1.6em', height: '1.8em', margin: '0 0.1em' }}
      viewBox="0 0 40 48"
    >
      <text x="20" y="16" textAnchor="middle" fontSize="16" fill="currentColor">{numerator}</text>
      <line x1="4" y1="23" x2="36" y2="23" stroke="currentColor" strokeWidth="1.5" />
      <text x="20" y="40" textAnchor="middle" fontSize="16" fill="currentColor">{denominator}</text>
    </svg>
  );
}

export function FractionText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(FRACTION_RE)) {
    const [full, numerator, denominator] = match;
    const idx = match.index!;
    if (idx > lastIndex) {
      parts.push(text.slice(lastIndex, idx));
    }
    parts.push(<InlineFraction key={idx} numerator={numerator} denominator={denominator} />);
    lastIndex = idx + full.length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return <>{parts}</>;
}
