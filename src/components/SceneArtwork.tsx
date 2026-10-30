/** Static slide artwork, drawn at the same 240 × 135 scale as scene previews. */
export function ScreenArtwork({ id }: { id: string }) {
  const ink = `${id}-slide-ink`;
  const ribbon = `${id}-slide-ribbon`;
  const spiral =
    "M218 43C196 21 161 31 153 57C143 88 172 111 199 104C225 98 235 72 220 55C205 37 179 44 175 64C171 81 190 94 203 83C214 74 205 59 193 65";

  return (
    <g>
      <defs>
        <linearGradient id={ink} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#272722" />
          <stop offset="1" stopColor="#414039" />
        </linearGradient>
        <linearGradient
          id={ribbon}
          gradientUnits="userSpaceOnUse"
          x1="158"
          y1="39"
          x2="220"
          y2="101"
        >
          <stop offset="0" stopColor="#ff733e" />
          <stop offset=".46" stopColor="#ff4000" />
          <stop offset="1" stopColor="#d93200" />
        </linearGradient>
      </defs>

      <rect width="240" height="135" fill="#f3f0e8" />
      <path d="M18 16h13v3H18z" fill="#ff4000" />
      <text
        x="36"
        y="19"
        fontFamily="DM Sans, sans-serif"
        fontWeight="650"
        fontSize="4.5"
        letterSpacing=".9"
        fill="#6e6b61"
      >
        IDEIAS QUE MOVEM
      </text>

      <text
        x="18"
        y="53"
        fontFamily="DM Sans, sans-serif"
        fontWeight="750"
        fontSize="17"
        letterSpacing="-.7"
        fill={`url(#${ink})`}
      >
        <tspan x="18">Sua próxima</tspan>
        <tspan x="18" dy="19">
          grande ideia.
        </tspan>
      </text>

      <path
        d="M18 85h80M18 90h64"
        stroke="#868277"
        strokeWidth="1.3"
        strokeLinecap="round"
      />

      <path
        d={spiral}
        transform="translate(0 2.2)"
        fill="none"
        stroke="#c9b5a4"
        strokeOpacity=".28"
        strokeWidth="10.5"
        strokeLinecap="round"
      />
      <path
        d={spiral}
        fill="none"
        stroke={`url(#${ribbon})`}
        strokeWidth="10.5"
        strokeLinecap="round"
      />
      <path
        d="M218 40C197 20 163 31 155 55"
        fill="none"
        stroke="#ffad80"
        strokeOpacity=".4"
        strokeWidth=".8"
        strokeLinecap="round"
      />

      <path d="M18 111h204" stroke="#d9d5cb" strokeWidth=".7" />
      <rect x="18" y="119" width="3" height="3" rx=".5" fill="#ff4000" />
      <text
        x="25"
        y="122"
        fontFamily="DM Sans, sans-serif"
        fontSize="4"
        fontWeight="550"
        letterSpacing=".6"
        fill="#7d796e"
      >
        UMA NOVA PERSPECTIVA
      </text>
      <text
        x="222"
        y="122"
        textAnchor="end"
        fontFamily="DM Sans, sans-serif"
        fontSize="4.5"
        fill="#7d796e"
      >
        01 / 06
      </text>
    </g>
  );
}

/** Quiet charcoal artwork leaves the center free for editable title and clock. */
export function CountdownArtwork({
  id,
  color,
}: {
  id: string;
  color: string;
}) {
  const glow = `${id}-countdown-glow`;
  const fin = `${id}-countdown-fin`;
  const base = color.toLowerCase() === "#080b11" ? "#171717" : color;

  return (
    <g>
      <defs>
        <radialGradient id={glow} cx="100%" cy="15%" r="96%">
          <stop offset="0" stopColor="#ff5824" stopOpacity=".28" />
          <stop offset=".36" stopColor="#ff4000" stopOpacity=".09" />
          <stop offset="1" stopColor="#ff4000" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={fin} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#ff8b5e" stopOpacity="0" />
          <stop offset=".89" stopColor="#ff8b5e" stopOpacity=".025" />
          <stop offset="1" stopColor="#ffd8bc" stopOpacity=".12" />
        </linearGradient>
      </defs>

      <rect width="240" height="135" fill={base} />
      <rect width="240" height="135" fill={`url(#${glow})`} />
      <g transform="translate(218 9) rotate(24)">
        <rect x="-9" y="-70" width="30" height="250" fill={`url(#${fin})`} />
        <rect x="30" y="-70" width="30" height="250" fill={`url(#${fin})`} />
        <rect x="69" y="-70" width="30" height="250" fill={`url(#${fin})`} />
      </g>
      <path
        d="M210-12C166 12 158 79 206 116M226-12C180 13 174 71 216 105M242-12C196 12 192 65 229 96"
        fill="none"
        stroke="#ff8758"
        strokeOpacity=".075"
        strokeWidth=".6"
      />
      <path d="M20 113h13" stroke="#ff7445" strokeOpacity=".7" strokeWidth="1.5" />
      <path d="M37 113h3" stroke="#ff7445" strokeOpacity=".24" strokeWidth="1.5" />
    </g>
  );
}
