// Generated from shared/display-scale.ts by scripts/sync-field-validation.mjs. Do not edit.
export const DISPLAY_SCALE_LIMITS = Object.freeze({ minimum: 1, maximum: 5, step: 0.1 });
const NORMAL_SCALE = Object.freeze({ tenths: 10, scale: 1, canonical: "1.0" });
const DISPLAY_SCALE = /^(?:[1-4](?:\.[0-9])?|5(?:\.0)?)$/u;
/** Parse authored tenths without floating-point remainder or whitespace normalization. */
export function parseDisplayScale(value) {
    if (value === undefined || value === "")
        return NORMAL_SCALE;
    if (typeof value !== "string" || DISPLAY_SCALE.exec(value)?.[0] !== value)
        return null;
    const whole = value.charCodeAt(0) - 48;
    const fraction = value.length === 3 ? value.charCodeAt(2) - 48 : 0;
    const tenths = whole * 10 + fraction;
    return tenths === 10
        ? NORMAL_SCALE
        : Object.freeze({ tenths, scale: tenths / 10, canonical: `${whole}.${fraction}` });
}
