// Package exports intentionally do not expose this test-only override.
export const DIRECTORY_LIMITS_OVERRIDE = Symbol("taproot.docs.directoryLimitsOverride");
export const FILE_OPEN_RACE_HOOK = Symbol("taproot.docs.fileOpenRaceHook");
export const FILE_READ_RACE_HOOK = Symbol("taproot.docs.fileReadRaceHook");
