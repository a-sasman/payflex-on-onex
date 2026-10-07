const fallbackPrefix = "astro-scorm-course-shell-interaction:";

export function readInteraction<T>(id: string): T | undefined {
  const courseState = (window as any).CourseState;
  if (courseState?.getInteraction) return courseState.getInteraction(id) as T | undefined;
  try {
    const stored = localStorage.getItem(`${fallbackPrefix}${id}`);
    return stored ? JSON.parse(stored) as T : undefined;
  } catch {
    return undefined;
  }
}

export function writeInteraction(id: string, value: unknown): void {
  try { localStorage.setItem(`${fallbackPrefix}${id}`, JSON.stringify(value)); } catch {}
  (window as any).CourseState?.setInteraction?.(id, value);
}

export function whenCourseStateReady(callback: () => void): void {
  if ((window as any).CourseState) callback();
  else window.addEventListener("course-state-ready", callback, { once: true });
}
