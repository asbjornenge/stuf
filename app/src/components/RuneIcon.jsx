import React from 'react';

export default function RuneIcon({ size = '1em', style }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 120 200"
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: 'inline-block', verticalAlign: 'middle', ...style }}
    >
      <defs>
        <linearGradient id="runeGradient" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#E85D24"/>
          <stop offset="70%" stopColor="#EF7A30"/>
          <stop offset="100%" stopColor="#F5C030"/>
        </linearGradient>
        <mask id="runeMask">
          <line x1="60" y1="10" x2="60" y2="190" stroke="white" strokeWidth="20" strokeLinecap="round"/>
          <line x1="22" y1="100" x2="60" y2="124" stroke="white" strokeWidth="17" strokeLinecap="round"/>
          <line x1="60" y1="124" x2="100" y2="76" stroke="white" strokeWidth="17" strokeLinecap="round"/>
        </mask>
      </defs>
      <rect x="0" y="0" width="120" height="200" fill="url(#runeGradient)" mask="url(#runeMask)"/>
    </svg>
  );
}
