/**
 * A character's unit frame: three stacked bars the way the client draws them —
 * health, power tinted by type, experience with the level badged at the left.
 * The arithmetic and the colour choice are `lib/unitframe.ts`; this is the
 * markup. No images and no fonts: the bevel is a gradient in `styles.css`.
 */

import { Show } from "solid-js";
import { type PowerType, barReading, healthReading, powerToken, xpToNext } from "../lib/unitframe";

export interface UnitFrameProps {
  level: number | null | undefined;
  xp: number | null | undefined;
  nextLevelXp?: number | null | undefined;
  health?: number | null | undefined;
  maxHealth?: number | null | undefined;
  power?: number | null | undefined;
  maxPower?: number | null | undefined;
  powerType?: PowerType | undefined;
  dead?: boolean | null | undefined;
}

function Bar(props: { cls: string; pct: number; text: string; title: string; observed: boolean; fill?: string; dead?: boolean }) {
  return (
    <div
      class={`bar ${props.cls}${props.observed ? "" : " unobserved"}${props.dead ? " dead" : ""}`}
      title={props.title}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={props.pct}
    >
      <div class="bar-fill" style={{ width: `${props.pct}%`, ...(props.fill ? { "background-color": props.fill } : {}) }} />
      <span class="bar-text">{props.text}</span>
    </div>
  );
}

/**
 * The experience row on its own: the level badge and the xp bar, at the size a
 * line of text wants.
 *
 * Exported rather than copied, because the frame's bar is the site's bar — the
 * bevel, the track, the unobserved treatment and the level badge are one set of
 * rules in `styles.css` and one `Bar` here. The character card needed the
 * reading without the health and power bars above it, which is a narrower use
 * of this component, not a second one.
 */
export function XpBar(props: Pick<UnitFrameProps, "level" | "xp" | "nextLevelXp">) {
  const next = () => xpToNext(props.level, props.nextLevelXp);
  const xp = () => barReading(props.xp, next());
  return (
    <span class="xp-row xp-inline">
      <span class="level-badge" title="level">
        <Show when={typeof props.level === "number"} fallback="—">{props.level}</Show>
      </span>
      <Bar cls="xp" pct={xp().pct} text={xp().text} title={xp().title} observed={xp().observed} />
    </span>
  );
}

export function UnitFrame(props: UnitFrameProps) {
  const hp = () => healthReading(props.health, props.maxHealth, props.dead);
  const pw = () => barReading(props.power, props.maxPower);
  const next = () => xpToNext(props.level, props.nextLevelXp);
  const xp = () => barReading(props.xp, next());
  return (
    <div class="unit-frame">
      <Bar cls="hp" pct={hp().pct} text={hp().text} title={hp().dead ? "dead" : hp().title} observed={hp().observed} dead={hp().dead} />
      <Bar cls="pw" pct={pw().pct} text={pw().text} title={pw().title} observed={pw().observed} fill={powerToken(props.powerType ?? "mana")} />
      <div class="xp-row">
        <span class="level-badge" title="level">
          <Show when={typeof props.level === "number"} fallback="—">{props.level}</Show>
        </span>
        <Bar cls="xp" pct={xp().pct} text={xp().text} title={xp().title} observed={xp().observed} />
      </div>
    </div>
  );
}
