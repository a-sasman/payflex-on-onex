import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const wrapper = await readFile(new URL("../public/course-runtime.js", import.meta.url), "utf8");

function launch(initialValues = {}, options = {}) {
  const calls = [];
  const listeners = {};
  const values = { ...initialValues };
  const api = {
    LMSInitialize(value) { calls.push(["LMSInitialize", value]); return options.initializeFails ? "false" : "true"; },
    LMSGetValue(element) { calls.push(["LMSGetValue", element]); return values[element] ?? ""; },
    LMSSetValue(element, value) {
      calls.push(["LMSSetValue", element, value]);
      if (options.setFails?.includes(element)) return "false";
      values[element] = value;
      return "true";
    },
    LMSCommit(value) { calls.push(["LMSCommit", value]); return options.commitFails ? "false" : "true"; },
    LMSFinish(value) { calls.push(["LMSFinish", value]); return "true"; },
  };
  const window = { API: api, opener: null, addEventListener(type, listener) { listeners[type] = listener; } };
  window.parent = window;
  vm.runInNewContext(wrapper, { window });
  return { calls, listeners, course: window.CourseSCORM, values };
}

const count = (calls, method, element) => calls.filter((call) => call[0] === method && (element === undefined || call[1] === element)).length;
const find = (calls, method, element, value, after = -1) => calls.findIndex((call, index) => index > after && call[0] === method && (element === undefined || call[1] === element) && (value === undefined || call[2] === value));

const fresh = launch({
  "cmi.core.lesson_status": "not attempted",
  "cmi.core.entry": "",
  "cmi.core.lesson_location": "",
  "cmi.core.total_time": "0000:00:00.00",
});
assert.equal(fresh.values["cmi.core.lesson_status"], "completed");
assert.equal(fresh.values["cmi.core.exit"], "");
const completedOnLaunch = find(fresh.calls, "LMSSetValue", "cmi.core.lesson_status", "completed");
assert.ok(completedOnLaunch > find(fresh.calls, "LMSInitialize"));
assert.ok(find(fresh.calls, "LMSCommit", undefined, undefined, completedOnLaunch) > completedOnLaunch);
assert.equal(fresh.course.getLastCommitSucceeded(), true);

fresh.calls.length = 0;
const middleState = JSON.stringify({ version: 1, currentSection: "exclusions", viewedSections: ["welcome", "exclusions"] });
assert.equal(fresh.course.saveProgress(middleState, "exclusions"), true);
assert.equal(fresh.values["cmi.suspend_data"], middleState);
assert.equal(fresh.values["cmi.core.lesson_location"], "exclusions");
assert.equal(fresh.values["cmi.core.lesson_status"], "completed");
assert.equal(fresh.values["cmi.core.exit"], "");
assert.equal(count(fresh.calls, "LMSSetValue", "cmi.core.lesson_status"), 0);

const completedResume = launch({ ...fresh.values, "cmi.core.entry": "resume" });
assert.equal(completedResume.course.getSuspendData(), middleState);
assert.equal(completedResume.course.getLessonStatus(), "completed");
assert.equal(find(completedResume.calls, "LMSSetValue", "cmi.core.lesson_status", "incomplete"), -1);
assert.equal(find(completedResume.calls, "LMSSetValue", "cmi.core.lesson_status", "completed"), -1);
completedResume.calls.length = 0;
assert.equal(completedResume.listeners.pagehide(), true);
assert.equal(completedResume.listeners.beforeunload(), true);
assert.equal(completedResume.values["cmi.core.lesson_status"], "completed");
assert.equal(completedResume.values["cmi.core.exit"], "");
assert.equal(count(completedResume.calls, "LMSCommit"), 1);
assert.equal(count(completedResume.calls, "LMSFinish"), 1);

fresh.calls.length = 0;
assert.equal(fresh.course.setCompleted(), true);
assert.equal(count(fresh.calls, "LMSSetValue", "cmi.core.lesson_status"), 0);
assert.equal(fresh.values["cmi.core.lesson_status"], "completed");
assert.equal(fresh.values["cmi.core.exit"], "");

fresh.calls.length = 0;
assert.equal(fresh.course.finish(), true);
assert.equal(count(fresh.calls, "LMSCommit"), 1);
assert.equal(count(fresh.calls, "LMSFinish"), 1);
assert.ok(find(fresh.calls, "LMSFinish") > find(fresh.calls, "LMSCommit"));
assert.equal(fresh.values["cmi.core.lesson_status"], "completed");
assert.equal(fresh.values["cmi.core.exit"], "");

const reopened = launch({ ...fresh.values, "cmi.core.entry": "resume" });
assert.equal(reopened.course.getLessonStatus(), "completed");
assert.equal(find(reopened.calls, "LMSSetValue", "cmi.core.lesson_status", "incomplete"), -1);
assert.equal(find(reopened.calls, "LMSSetValue", "cmi.core.lesson_status", "completed"), -1);

const oversized = JSON.stringify({ version: 1, padding: "x".repeat(4096) });
reopened.calls.length = 0;
assert.equal(reopened.course.saveProgress(oversized, "complete"), false);
assert.equal(count(reopened.calls, "LMSSetValue"), 0);
assert.equal(count(reopened.calls, "LMSCommit"), 0);

const failing = launch({ "cmi.core.lesson_status": "not attempted", "cmi.core.lesson_location": "returns" }, { commitFails: true });
assert.equal(failing.values["cmi.core.lesson_status"], "completed");
assert.equal(failing.course.getLastCommitSucceeded(), false);
failing.calls.length = 0;
assert.equal(failing.listeners.pagehide(), false);
assert.equal(failing.listeners.beforeunload(), false);
assert.equal(count(failing.calls, "LMSFinish"), 0);

const unavailable = launch({}, { initializeFails: true });
assert.equal(unavailable.course.initialize(), false);
assert.equal(unavailable.listeners.pagehide(), true);
assert.equal(count(unavailable.calls, "LMSFinish"), 0);

console.log("SCORM 1.2 API verification passed: launch completion and immediate commit, progress persistence without status changes, completed close, guarded finish, resume, commit-failure protection, and API-unavailable fallback.");
