(function (global) {
  "use strict";

  var api = null;
  var initialized = false;
  var finished = false;
  var sessionStartedAt = 0;
  var lessonStatus = "";
  var totalTime = "";
  var entry = "";
  var lessonLocation = "";
  var lastCommitSucceeded = null;

  function findApi(startWindow, includeOpener) {
    var current = startWindow;
    var attempts = 0;
    while (current && attempts < 50) {
      try {
        if (current.API) return current.API;
        if (!current.parent || current.parent === current) break;
        current = current.parent;
      } catch (_error) { break; }
      attempts += 1;
    }
    try {
      if (includeOpener !== false && global.opener && global.opener !== global) return findApi(global.opener, false);
    } catch (_error) { return null; }
    return null;
  }

  function call(method) {
    if (!api || typeof api[method] !== "function") return "false";
    try { return api[method].apply(api, Array.prototype.slice.call(arguments, 1)); }
    catch (_error) { return "false"; }
  }

  function formatTime(milliseconds) {
    var totalCentiseconds = Math.max(0, Math.floor(milliseconds / 10));
    var centiseconds = totalCentiseconds % 100;
    var totalSeconds = Math.floor(totalCentiseconds / 100);
    var seconds = totalSeconds % 60;
    var totalMinutes = Math.floor(totalSeconds / 60);
    var minutes = totalMinutes % 60;
    var hours = Math.min(Math.floor(totalMinutes / 60), 9999);
    return String(hours).padStart(4, "0") + ":" + String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0") + "." + String(centiseconds).padStart(2, "0");
  }

  function updateSessionTime() {
    if (!initialized || !sessionStartedAt) return false;
    return String(call("LMSSetValue", "cmi.core.session_time", formatTime(Date.now() - sessionStartedAt))).toLowerCase() === "true";
  }

  function initialize() {
    if (initialized) return true;
    api = findApi(global);
    if (!api || String(call("LMSInitialize", "")).toLowerCase() !== "true") return false;
    initialized = true;
    sessionStartedAt = Date.now();
    lessonStatus = String(call("LMSGetValue", "cmi.core.lesson_status") || "").toLowerCase();
    totalTime = String(call("LMSGetValue", "cmi.core.total_time") || "");
    entry = String(call("LMSGetValue", "cmi.core.entry") || "").toLowerCase();
    lessonLocation = String(call("LMSGetValue", "cmi.core.lesson_location") || "");
    if (!lessonStatus || lessonStatus === "not attempted" || lessonStatus === "unknown") {
      if (String(call("LMSSetValue", "cmi.core.lesson_status", "incomplete")).toLowerCase() !== "true") {
        lastCommitSucceeded = false;
        return true;
      }
      lessonStatus = "incomplete";
    }
    if (String(call("LMSSetValue", "cmi.core.exit", lessonStatus === "completed" || lessonStatus === "passed" ? "" : "suspend")).toLowerCase() !== "true") {
      lastCommitSucceeded = false;
      return true;
    }
    updateSessionTime();
    lastCommitSucceeded = String(call("LMSCommit", "")).toLowerCase() === "true";
    return true;
  }

  function setValue(element, value) {
    if (!initialize()) return false;
    try { return String(api.LMSSetValue(element, value)).toLowerCase() === "true"; }
    catch (_error) { return false; }
  }

  function commit() {
    if (!initialize()) return false;
    updateSessionTime();
    lastCommitSucceeded = String(call("LMSCommit", "")).toLowerCase() === "true";
    return lastCommitSucceeded;
  }

  function getLessonStatus() {
    if (!initialize()) return "";
    lessonStatus = String(call("LMSGetValue", "cmi.core.lesson_status") || lessonStatus).toLowerCase();
    return lessonStatus;
  }

  function getCompletionStatus() { return getLessonStatus(); }
  function getEntry() {
    if (!initialize()) return "";
    entry = String(call("LMSGetValue", "cmi.core.entry") || entry).toLowerCase();
    return entry;
  }
  function getLessonLocation() {
    if (!initialize()) return "";
    lessonLocation = String(call("LMSGetValue", "cmi.core.lesson_location") || lessonLocation);
    return lessonLocation;
  }
  function getTotalTime() {
    if (!initialize()) return "";
    totalTime = String(call("LMSGetValue", "cmi.core.total_time") || totalTime);
    return totalTime;
  }
  function getSuspendData() {
    if (!initialize()) return "";
    return String(call("LMSGetValue", "cmi.suspend_data") || "");
  }
  function setSuspendData(value) {
    var serialized = String(value);
    if (serialized.length > 4096) { lastCommitSucceeded = false; return false; }
    if (!setValue("cmi.suspend_data", serialized)) { lastCommitSucceeded = false; return false; }
    return commit();
  }
  function saveProgress(value, location) {
    if (!initialize()) return false;
    var serialized = String(value);
    var nextLocation = String(location || "");
    if (serialized.length > 4096 || !nextLocation) { lastCommitSucceeded = false; return false; }
    if (!setValue("cmi.suspend_data", serialized)) { lastCommitSucceeded = false; return false; }
    if (!setValue("cmi.core.lesson_location", nextLocation)) { lastCommitSucceeded = false; return false; }
    lessonLocation = nextLocation;
    var currentStatus = getLessonStatus();
    if (currentStatus !== "completed" && currentStatus !== "passed") {
      if (!setValue("cmi.core.exit", "suspend")) { lastCommitSucceeded = false; return false; }
    }
    return commit();
  }
  function setCompleted() {
    if (!initialize()) return false;
    var currentStatus = getLessonStatus();
    if (currentStatus !== "completed") {
      if (!setValue("cmi.core.lesson_status", "completed")) { lastCommitSucceeded = false; return false; }
      lessonStatus = "completed";
    }
    if (!setValue("cmi.core.exit", "")) { lastCommitSucceeded = false; return false; }
    lastCommitSucceeded = commit();
    if (!lastCommitSucceeded && currentStatus !== "completed" && currentStatus !== "passed") {
      call("LMSSetValue", "cmi.core.lesson_status", currentStatus || "incomplete");
      call("LMSSetValue", "cmi.core.exit", "suspend");
      lessonStatus = currentStatus || "incomplete";
    }
    return lastCommitSucceeded;
  }
  function finish() {
    if (!initialized || finished) return true;
    lessonStatus = String(call("LMSGetValue", "cmi.core.lesson_status") || lessonStatus).toLowerCase();
    updateSessionTime();
    if (String(call("LMSSetValue", "cmi.core.exit", lessonStatus === "completed" || lessonStatus === "passed" ? "" : "suspend")).toLowerCase() !== "true") {
      lastCommitSucceeded = false;
      return false;
    }
    lastCommitSucceeded = String(call("LMSCommit", "")).toLowerCase() === "true";
    if (!lastCommitSucceeded) return false;
    var result = String(call("LMSFinish", "")).toLowerCase() === "true";
    if (result) finished = true;
    return result;
  }

  function getLastCommitSucceeded() { return lastCommitSucceeded; }

  global.CourseSCORM = { initialize: initialize, getLessonStatus: getLessonStatus, getCompletionStatus: getCompletionStatus, getEntry: getEntry, getLessonLocation: getLessonLocation, getTotalTime: getTotalTime, getSuspendData: getSuspendData, setSuspendData: setSuspendData, saveProgress: saveProgress, setCompleted: setCompleted, commit: commit, finish: finish, getLastCommitSucceeded: getLastCommitSucceeded };
  initialize();
  global.addEventListener("pagehide", finish);
  global.addEventListener("beforeunload", finish);
})(window);
