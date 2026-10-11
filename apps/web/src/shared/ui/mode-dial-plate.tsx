import type { ModeId } from "@dx/domain";
import { CLAUDE_MARK_PATH } from "./claude-icon.js";
import {
  DIAL_CENTER,
  DIAL_LABELS,
  DIAL_MODE_ORDER,
  DIAL_POSITION_BY_MODE,
  DIAL_TICKS,
  KNOB_RIDGES,
  pointOnDial,
} from "./mode-dial-geometry.js";

/** The dial's Claude Code position, straight below the knob. */
export const CLAUDE_CODE_DIAL_ANGLE = 90;

/** Claude Code on the dial: a lamp below the knob, lit when it is chosen. */
export type ModeDialClaudeCode = {
  readonly selected: boolean;
  readonly model: string;
  readonly effort: string;
};

export function ModeDialPlate({
  profile,
  selectedAngle,
  agentEffort,
  displayModel,
  resolutionLabel,
  agentOnly = false,
  claudeCode,
}: {
  readonly profile: ModeId;
  readonly selectedAngle: number;
  readonly agentEffort: string;
  readonly displayModel: string;
  readonly resolutionLabel: string;
  readonly agentOnly?: boolean;
  readonly claudeCode?: ModeDialClaudeCode | undefined;
}) {
  const height = claudeCode === undefined ? 168 : 196;
  const claudeSelected = claudeCode?.selected === true;
  const angle = claudeSelected ? CLAUDE_CODE_DIAL_ANGLE : selectedAngle;
  return (
    <svg
      className="reasoning-console-plate"
      data-claude-code={claudeSelected || undefined}
      viewBox={`0 0 400 ${height}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <title>Mode selector</title>
      <PlateDefs />
      <rect
        x="1"
        y="1"
        width="398"
        height={height - 2}
        rx="9"
        fill="url(#dx-mode-plate)"
        stroke="#45484f"
      />
      <rect
        x="2"
        y="2"
        width="396"
        height={height - 4}
        rx="8"
        filter="url(#dx-mode-grain)"
        opacity="0.22"
      />
      {[14, 386].flatMap((x) =>
        [14, height - 13].map((y) => (
          <g key={`${x}-${y}`} className="mode-plate-screw">
            <circle cx={x} cy={y} r="3.4" />
            <line x1={x - 1.7} y1={y - 1.7} x2={x + 1.7} y2={y + 1.7} />
            <line x1={x + 1.7} y1={y - 1.7} x2={x - 1.7} y2={y + 1.7} />
          </g>
        )),
      )}
      {DIAL_TICKS.map((tick) => (
        <line
          key={tick.id}
          x1={tick.x1}
          y1={tick.y1}
          x2={tick.x2}
          y2={tick.y2}
          className={`mode-dial-tick ${tick.angle <= angle ? "active" : ""}`}
        />
      ))}
      {DIAL_MODE_ORDER.map((id) => {
        const position = DIAL_POSITION_BY_MODE[id];
        const inner = pointOnDial(position.angle, 49);
        const outer = pointOnDial(position.angle, 56);
        const light = pointOnDial(position.angle, 63);
        const active = id === profile && !claudeSelected;
        return (
          <g
            key={id}
            className={
              active ? "mode-dial-position active" : "mode-dial-position"
            }
          >
            <line x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y} />
            <circle cx={light.x} cy={light.y} r="2.4" />
            <text
              x={position.labelX}
              y={position.labelY}
              textAnchor="middle"
              dominantBaseline="middle"
              className="mode-plate-label"
            >
              {DIAL_LABELS[id]}
            </text>
          </g>
        );
      })}
      <circle
        cx={DIAL_CENTER.x}
        cy={DIAL_CENTER.y}
        r="47"
        fill="#090a0d"
        stroke="#08090b"
        strokeWidth="2.5"
        filter="url(#dx-mode-knob-shadow)"
      />
      <circle
        cx={DIAL_CENTER.x}
        cy={DIAL_CENTER.y}
        r="43"
        fill="url(#dx-mode-knob)"
        stroke="#0a0b0d"
        strokeWidth="1"
      />
      <g
        className="mode-dial-rotor"
        style={{
          transform: `rotate(${angle - 270}deg)`,
          transformOrigin: `${DIAL_CENTER.x}px ${DIAL_CENTER.y}px`,
        }}
      >
        {KNOB_RIDGES.map((ridge) => (
          <line
            key={ridge.id}
            x1={ridge.x1}
            y1={ridge.y1}
            x2={ridge.x2}
            y2={ridge.y2}
            className="mode-knob-ridge"
          />
        ))}
        <circle
          cx={DIAL_CENTER.x}
          cy={DIAL_CENTER.y}
          r="33"
          fill="url(#dx-mode-cap)"
          className="mode-knob-cap"
        />
        {[9, 15, 21, 27, 31].map((radius) => (
          <circle
            key={radius}
            cx={DIAL_CENTER.x}
            cy={DIAL_CENTER.y}
            r={radius}
            className="mode-knob-ring"
          />
        ))}
        <line
          x1={DIAL_CENTER.x}
          y1={DIAL_CENTER.y - 34}
          x2={DIAL_CENTER.x}
          y2={DIAL_CENTER.y - 13}
          className="mode-dial-needle-shadow"
        />
        <line
          x1={DIAL_CENTER.x}
          y1={DIAL_CENTER.y - 34}
          x2={DIAL_CENTER.x}
          y2={DIAL_CENTER.y - 13}
          className="mode-dial-needle"
        />
      </g>
      <circle
        cx={DIAL_CENTER.x}
        cy={DIAL_CENTER.y}
        r="42"
        fill="url(#dx-mode-spec)"
        pointerEvents="none"
      />
      {claudeCode === undefined ? null : (
        <ClaudeCodeLamp lit={claudeSelected} />
      )}
      {claudeSelected && claudeCode !== undefined ? (
        <ClaudeCodeDisplay
          model={claudeCode.model}
          effort={claudeCode.effort}
        />
      ) : (
        <AgentDisplay
          profile={profile}
          agentEffort={agentEffort}
          displayModel={displayModel}
          resolutionLabel={resolutionLabel}
          agentOnly={agentOnly}
          captionY={claudeCode === undefined ? 163 : 184}
        />
      )}
    </svg>
  );
}

/** Below the knob: the Claude mark in a lamp, and its label. */
function ClaudeCodeLamp({ lit }: { readonly lit: boolean }) {
  const center = pointOnDial(CLAUDE_CODE_DIAL_ANGLE, 63);
  return (
    <g className={lit ? "mode-claude-lamp lit" : "mode-claude-lamp"}>
      <line
        x1={center.x}
        y1={center.y - 14}
        x2={center.x}
        y2={center.y - 9}
        className="mode-claude-lamp-tick"
      />
      <circle cx={center.x} cy={center.y} r="7" className="mode-claude-bezel" />
      <circle
        cx={center.x}
        cy={center.y}
        r="5.6"
        className="mode-claude-glass"
      />
      <path
        d={CLAUDE_MARK_PATH}
        className="mode-claude-mark"
        transform={`translate(${center.x - 4.2} ${center.y - 4.2}) scale(0.35)`}
      />
      <text
        x={center.x + 12}
        y={center.y}
        dominantBaseline="middle"
        className="mode-plate-label mode-claude-label"
      >
        CLAUDE CODE
      </text>
    </g>
  );
}

/** The display while Claude Code is chosen: its model and effort. */
function ClaudeCodeDisplay({
  model,
  effort,
}: {
  readonly model: string;
  readonly effort: string;
}) {
  return (
    <>
      <rect
        x="225"
        y="38"
        width="163"
        height="91"
        rx="7"
        fill="#090d0c"
        stroke="#0a0b0d"
        strokeWidth="5"
      />
      <rect
        x="228"
        y="43"
        width="157"
        height="81"
        rx="3"
        className="mode-display-screen mode-display-claude"
      />
      {[
        { label: "MODEL", value: model, y: 66 },
        { label: "EFFORT", value: effort, y: 104 },
      ].map(({ label, value, y }) => (
        <g key={label}>
          <text x="236" y={y} className="mode-display-label">
            {label}
          </text>
          <text x="367" y={y} textAnchor="end" className="mode-display-value">
            {value}
          </text>
          <path
            d={`M371 ${y - 4.5}l3 3 3-3`}
            className="mode-display-chevron"
          />
        </g>
      ))}
      <line
        x1="233"
        y1="84"
        x2="380"
        y2="84"
        className="mode-display-divider"
      />
      <text
        x="200"
        y="186"
        textAnchor="middle"
        className="mode-subscription-copy"
      >
        USES YOUR CLAUDE PRO/MAX PLAN
      </text>
    </>
  );
}

/** Gradients and filters the plate draws with. */
function PlateDefs() {
  return (
    <defs>
      <linearGradient id="dx-mode-plate" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#383b42" />
        <stop offset="0.1" stopColor="#2d3036" />
        <stop offset="1" stopColor="#181a1e" />
      </linearGradient>
      <radialGradient id="dx-mode-knob" cx="34%" cy="27%" r="78%">
        <stop offset="0" stopColor="#656a73" />
        <stop offset="0.52" stopColor="#393c43" />
        <stop offset="1" stopColor="#17191d" />
      </radialGradient>
      <radialGradient id="dx-mode-cap" cx="38%" cy="30%" r="90%">
        <stop offset="0" stopColor="#4b4f57" />
        <stop offset="0.7" stopColor="#30333a" />
        <stop offset="1" stopColor="#1d1f24" />
      </radialGradient>
      <linearGradient id="dx-mode-spec" x1="0" y1="0" x2="0.4" y2="1">
        <stop offset="0" stopColor="#fff" stopOpacity="0.14" />
        <stop offset="0.45" stopColor="#fff" stopOpacity="0.02" />
        <stop offset="1" stopColor="#fff" stopOpacity="0" />
      </linearGradient>
      <filter id="dx-mode-grain" x="0" y="0" width="100%" height="100%">
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.72"
          numOctaves="1"
          seed="8"
        />
        <feColorMatrix
          type="matrix"
          values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0.08 0"
        />
      </filter>
      <filter
        id="dx-mode-knob-shadow"
        x="-30%"
        y="-30%"
        width="160%"
        height="170%"
      >
        <feDropShadow
          dx="0"
          dy="2"
          stdDeviation="1.5"
          floodColor="#000"
          floodOpacity="0.65"
        />
      </filter>
      <filter id="dx-mode-glow">
        <feGaussianBlur stdDeviation="1.8" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </defs>
  );
}

/** The display while a mode or raw model is chosen. */
function AgentDisplay({
  profile,
  agentEffort,
  displayModel,
  resolutionLabel,
  agentOnly,
  captionY,
}: {
  readonly profile: ModeId;
  readonly agentEffort: string;
  readonly displayModel: string;
  readonly resolutionLabel: string;
  readonly agentOnly: boolean;
  readonly captionY: number;
}) {
  return (
    <>
      <rect
        x="225"
        y={agentOnly ? 59 : 38}
        width="163"
        height={agentOnly ? 49 : 91}
        rx="7"
        fill="#090d0c"
        stroke="#0a0b0d"
        strokeWidth="5"
      />
      <rect
        x="228"
        y={agentOnly ? 64 : 43}
        width="157"
        height={agentOnly ? 39 : 81}
        rx="3"
        className="mode-display-screen"
      />
      <text x="235" y={agentOnly ? 80 : 59} className="mode-display-label">
        AGENT
      </text>
      <text
        x="378"
        y={agentOnly ? 80 : 59}
        textAnchor="end"
        className="mode-display-value"
      >
        {displayModel}
      </text>
      <text
        x="378"
        y={agentOnly ? 94 : 73}
        textAnchor="end"
        className="mode-display-value"
      >
        {agentOnly ? agentEffort : `SOL ${agentEffort}`}
      </text>
      {!agentOnly ? (
        <>
          <line
            x1="233"
            y1="83"
            x2="380"
            y2="83"
            className="mode-display-divider"
          />
          <text x="235" y="100" className="mode-display-label">
            RESOLUTION
          </text>
          <text x="378" y="100" textAnchor="end" className="mode-display-value">
            {resolutionLabel}
          </text>
          <text x="378" y="114" textAnchor="end" className="mode-display-value">
            MODE {profile.toUpperCase()}
          </text>
        </>
      ) : null}
      <text x="120" y={captionY} className="mode-subscription-copy">
        {agentOnly ? resolutionLabel : "MODE RESOLVES WHEN YOU SEND"}
      </text>
    </>
  );
}
