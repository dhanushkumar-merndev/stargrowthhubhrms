import { redirectFor } from "./routing";

/** Preserves the origin page through replace navigations and browser traversal. */
export function trackBackNavigation() {
  const { history, location } = window;
  const { pushState, replaceState } = history;

  const push: History["pushState"] = (state, unused, url) => {
    pushState.call(history, { ...state, hrmsPreviousPath: location.pathname }, unused, url);
  };
  const replace: History["replaceState"] = (state, unused, url) => {
    replaceState.call(history, { ...state, hrmsPreviousPath: history.state?.hrmsPreviousPath ?? null }, unused, url);
  };
  history.pushState = push;
  history.replaceState = replace;

  return () => {
    if (history.pushState === push) history.pushState = pushState;
    if (history.replaceState === replace) history.replaceState = replaceState;
  };
}

export function hasPreviousAppPage(): boolean {
  const previous = window.history.state?.hrmsPreviousPath;
  return window.history.length > 1 && typeof previous === "string" && previous !== "/offline" && redirectFor("ready", previous) === null;
}
