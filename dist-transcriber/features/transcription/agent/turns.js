// The server's turn hint (room metadata, or its session state) as the
// transcriber's turn. Running means live and not paused.
export function parseTurnHint(metadata) {
    if (!metadata)
        return null;
    try {
        const value = JSON.parse(metadata);
        return value && value.v === 1 && typeof value.debateStatus === "string"
            ? value
            : null;
    }
    catch {
        return null;
    }
}
export function turnFromHint(hint) {
    if (hint.turnNumber === null ||
        hint.activeSide === null ||
        (hint.mediaState !== "running" && hint.mediaState !== "paused"))
        return null;
    const deadline = hint.turnDeadlineAt ? Date.parse(hint.turnDeadlineAt) : NaN;
    return {
        turnNumber: hint.turnNumber,
        side: hint.activeSide,
        deadlineAt: Number.isFinite(deadline) ? deadline : null,
        running: hint.mediaState === "running" && hint.debateStatus === "live",
    };
}
export function hintFromSession(state) {
    return {
        v: 1,
        debateStatus: state.debateStatus,
        mediaState: (state.media?.state ?? null),
        turnNumber: state.media?.turnNumber ?? null,
        activeSide: state.media?.activeSide ?? null,
        turnDeadlineAt: state.media?.turnDeadlineAt ?? null,
    };
}
