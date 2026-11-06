const READY = "NAVIGATION_PUBLISHING_READINESS_STATE_READY";
const BLOCKED = "NAVIGATION_PUBLISHING_READINESS_STATE_BLOCKED";
const UNKNOWN = "NAVIGATION_PUBLISHING_READINESS_STATE_UNKNOWN";
const REASON_PREFIX = "NAVIGATION_PUBLISHING_READINESS_BLOCKER_REASON_";
const MESSAGES = {
  PAGE_NOT_INCLUDED: "Include this approved page in the release.",
  PAGE_NOT_APPROVED: "Approve this page and include it in the release.",
  FOLDER_NEEDS_RELEASED_CONTENT: "Publish a qualifying page under this path, or approve and include one in this release.",
  TARGET_UNAVAILABLE: "Remove or replace this unavailable navigation target.",
};

export function normalizeNavigationReadiness(value) {
  return {
    state: [READY, BLOCKED].includes(value?.state) ? value.state : UNKNOWN,
    blockers: (Array.isArray(value?.blockers) ? value.blockers : []).map((blocker) => ({
      resourceId: typeof blocker?.resourceId === "string" ? blocker.resourceId : "",
      pageId: typeof blocker?.pageId === "string" ? blocker.pageId : "",
      title: typeof blocker?.title === "string" ? blocker.title : "",
      path: typeof blocker?.path === "string" ? blocker.path : "",
      reason: typeof blocker?.reason === "string" ? blocker.reason : "",
    })),
  };
}

export function isNavigationReady(navigation) {
  return navigation.state === READY;
}

export function describeNavigationReadiness(navigation) {
  if (isNavigationReady(navigation)) return "Navigation is ready.";
  if (navigation.state !== BLOCKED) return "Navigation could not be checked. Try the readiness check again.";
  const details = navigation.blockers.slice(0, 20).map((blocker) => {
    const target = blocker.title || "Unavailable page";
    const path = blocker.pageId ? ` (/${blocker.path.replace(/^\/+/, "")})` : "";
    const message = MESSAGES[blocker.reason.replace(REASON_PREFIX, "")] || MESSAGES.TARGET_UNAVAILABLE;
    return `${target}${path}: ${message}`;
  });
  return details.length ? `Navigation is blocked. ${details.join(" ")}` : "Navigation cannot be published with this set.";
}

export function reportNavigationReadiness(navigation) {
  return {
    state: navigation.state,
    blockers: navigation.blockers.slice(0, 20),
    ...(navigation.blockers.length > 20 ? { blockersTruncated: true } : {}),
  };
}
