const {setGlobalOptions, logger} = require("firebase-functions/v2");
const {onDocumentCreated, onDocumentUpdated} = require("firebase-functions/v2/firestore");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore, FieldValue} = require("firebase-admin/firestore");
const {getMessaging} = require("firebase-admin/messaging");

initializeApp();
setGlobalOptions({
  region: "asia-northeast3",
  minInstances: 0,
  maxInstances: 1,
  timeoutSeconds: 60,
  memory: "256MiB",
});

const db = getFirestore();
const APP_URL = "https://eateni.github.io/TBSclub/";
const ICON_URL = `${APP_URL}tbs_logo.png`;
const DEFAULT_SETTINGS = {
  enabled: true,
  scheduleCreated: true,
  bracketReady: true,
  announcementCreated: true,
  attendanceReminder: true,
};

async function getSettings() {
  const snapshot = await db.doc("club/notificationSettings").get();
  return snapshot.exists ? {...DEFAULT_SETTINGS, ...snapshot.data()} : DEFAULT_SETTINGS;
}

async function claimAutomaticNotification(id, type) {
  const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 180);
  const ref = db.doc(`notificationEvents/${safeId}`);
  try {
    await ref.create({type, status: "processing", createdAt: FieldValue.serverTimestamp()});
    return ref;
  } catch (error) {
    if (error.code === 6 || error.code === "already-exists") return null;
    throw error;
  }
}

function validText(value, fallback, maxLength) {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, maxLength);
}

async function sendPush({title, body, url = APP_URL, target = "all"}) {
  const tokenSnapshot = await db.collection("pushTokens").get();
  const recipients = tokenSnapshot.docs
    .map((doc) => ({ref: doc.ref, ...doc.data()}))
    .filter((item) => item.enabled === true && typeof item.token === "string" && item.token.length > 20)
    .filter((item) => target !== "admin" || item.role === "admin");

  if (!recipients.length) return {successCount: 0, failureCount: 0, recipientCount: 0};

  let successCount = 0;
  let failureCount = 0;
  const invalidRefs = [];
  for (let offset = 0; offset < recipients.length; offset += 500) {
    const chunk = recipients.slice(offset, offset + 500);
    const response = await getMessaging().sendEachForMulticast({
      tokens: chunk.map((item) => item.token),
      notification: {title, body},
      data: {url},
      webpush: {
        notification: {icon: ICON_URL},
        fcmOptions: {link: url},
      },
    });
    successCount += response.successCount;
    failureCount += response.failureCount;
    response.responses.forEach((result, index) => {
      const code = result.error && result.error.code;
      if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
        invalidRefs.push(chunk[index].ref);
      }
    });
  }
  if (invalidRefs.length) {
    const batch = db.batch();
    invalidRefs.forEach((ref) => batch.delete(ref));
    await batch.commit();
  }
  return {successCount, failureCount, recipientCount: recipients.length};
}

async function completeAutomatic(ref, payload, result, error) {
  if (!ref) return;
  await ref.set({
    title: payload.title,
    body: payload.body,
    status: error ? "failed" : "sent",
    result: result || null,
    error: error ? String(error.message || error).slice(0, 500) : null,
    completedAt: FieldValue.serverTimestamp(),
  }, {merge: true});
}

async function sendAutomatic({eventId, type, settingKey, title, body, url}) {
  const settings = await getSettings();
  if (settings.enabled !== true || settings[settingKey] !== true) return null;
  const eventRef = await claimAutomaticNotification(eventId, type);
  if (!eventRef) return null;
  const payload = {title, body, url};
  try {
    const result = await sendPush(payload);
    await completeAutomatic(eventRef, payload, result, null);
    logger.info("TBS push sent", {type, ...result});
    return result;
  } catch (error) {
    await completeAutomatic(eventRef, payload, null, error);
    throw error;
  }
}

function countMatches(rounds) {
  return (rounds || []).reduce((total, round) => total + (round.matches || []).filter((match) =>
    !match.isRally && match.tag !== "랠리" && match.tag !== "휴식").length, 0);
}

exports.notifyScheduleCreated = onDocumentCreated("schedules/{scheduleId}", async (event) => {
  const schedule = event.data && event.data.data();
  if (!schedule) return;
  const date = validText(schedule.date, "새 일정", 30);
  const place = validText(schedule.place, "장소 미정", 80);
  await sendAutomatic({
    eventId: `schedule-${event.params.scheduleId}`,
    type: "scheduleCreated",
    settingKey: "scheduleCreated",
    title: "📅 새로운 일정이 등록됐어요",
    body: `${date} · ${place}`,
    url: `${APP_URL}#schedule`,
  });
});

exports.notifyGameDayCreated = onDocumentCreated("days/{dayId}", async (event) => {
  const day = event.data && event.data.data();
  if (!day) return;
  const date = validText(day.date, "새 경기", 30);
  const place = validText(day.place, "장소 미정", 80);
  await sendAutomatic({
    eventId: `game-day-${event.params.dayId}`,
    type: "scheduleCreated",
    settingKey: "scheduleCreated",
    title: "🎾 새로운 경기 일정이 등록됐어요",
    body: `${date} · ${place}`,
    url: `${APP_URL}#league`,
  });
});

exports.notifyBracketReady = onDocumentUpdated("days/{dayId}", async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (countMatches(before.rounds) > 0 || countMatches(after.rounds) === 0) return;
  const date = validText(after.date, "경기일", 30);
  await sendAutomatic({
    eventId: `bracket-${event.params.dayId}`,
    type: "bracketReady",
    settingKey: "bracketReady",
    title: "🏆 대진표가 공개됐어요",
    body: `${date} 경기 대진을 확인해주세요.`,
    url: `${APP_URL}#league`,
  });
});

exports.notifyAnnouncementCreated = onDocumentCreated("announcements/{announcementId}", async (event) => {
  const announcement = event.data && event.data.data();
  if (!announcement || announcement.active === false) return;
  await sendAutomatic({
    eventId: `announcement-${event.params.announcementId}`,
    type: "announcementCreated",
    settingKey: "announcementCreated",
    title: `📢 ${validText(announcement.title, "새로운 클럽 공지", 70)}`,
    body: validText(announcement.content, "새 공지를 확인해주세요.", 180),
    url: `${APP_URL}#schedule`,
  });
});

exports.processNotificationRequest = onDocumentCreated("notificationRequests/{requestId}", async (event) => {
  const ref = event.data.ref;
  const claimed = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists || snapshot.data().status !== "queued") return null;
    transaction.update(ref, {status: "processing", startedAt: FieldValue.serverTimestamp()});
    return snapshot.data();
  });
  if (!claimed) return;

  const settings = await getSettings();
  const type = claimed.type || "custom";
  if (type !== "test" && settings.enabled !== true) {
    await ref.update({status: "skipped", error: "알림 전체 설정이 꺼져 있습니다.", completedAt: FieldValue.serverTimestamp()});
    return;
  }
  if (type === "attendance" && settings.attendanceReminder !== true) {
    await ref.update({status: "skipped", error: "참석 요청 알림이 꺼져 있습니다.", completedAt: FieldValue.serverTimestamp()});
    return;
  }

  let title = validText(claimed.title, "🔔 TBS HISTORY", 70);
  let body = validText(claimed.body, "새 알림을 확인해주세요.", 180);
  let url = validText(claimed.url, APP_URL, 300);
  if (type === "attendance") {
    title = "🎾 경기 참석 여부를 선택해주세요";
    body = `${validText(claimed.date, "예정된 경기", 30)}${claimed.place ? ` · ${validText(claimed.place, "", 80)}` : ""}`;
    url = `${APP_URL}#schedule`;
  }
  try {
    const result = await sendPush({title, body, url, target: claimed.target === "admin" ? "admin" : "all"});
    await ref.update({status: "sent", title, body, result, completedAt: FieldValue.serverTimestamp()});
  } catch (error) {
    await ref.update({status: "failed", error: String(error.message || error).slice(0, 500), completedAt: FieldValue.serverTimestamp()});
    throw error;
  }
});
