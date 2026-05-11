// ================================================================
//  StreakOS — app.js
//  Advanced Habit & Streak Tracker
//  Firebase Firestore v9 + Storage v9 | Vanilla JS ES Modules
// ================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, addDoc, getDocs, getDoc,
  setDoc, deleteDoc, doc, query, orderBy, serverTimestamp, updateDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getStorage, ref as storageRef, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

// ================================================================
//  🔥 FIREBASE CONFIGURATION — Điền thông tin project của bạn
// ================================================================
const firebaseConfig = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT_ID.firebaseapp.com",
  projectId:         "YOUR_PROJECT_ID",
  storageBucket:     "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId:             "YOUR_APP_ID",
};

// ================================================================
//  INIT
// ================================================================
let app, db, storage;
try {
  app     = initializeApp(firebaseConfig);
  db      = getFirestore(app);
  storage = getStorage(app);
} catch (e) {
  showToast("Lỗi Firebase", "Hãy cấu hình firebaseConfig trong app.js", "error");
}

// ================================================================
//  STATE
// ================================================================
const state = {
  streaks:          [],       // Array of { id, ...data }
  checkinsByStreak: {},       // { streakId: { "YYYY-MM-DD": checkinData } }
  currentStreakId:  null,     // Streak being checked in
  pomodoroInterval: null,
  pomodoroSeconds:  25 * 60,
  pomodoroRunning:  false,
  pomodoroElapsed:  0,
  uploadedImageFile: null,
  pendingDeleteId:  null,
};

// ================================================================
//  DATE UTILITIES
// ================================================================
const toDateStr = (d = new Date()) => d.toISOString().slice(0, 10);

const daysBetween = (a, b) => {
  const ms = Math.abs(new Date(b) - new Date(a));
  return Math.floor(ms / 86400000);
};

const getWeekStart = (d = new Date()) => {
  const day = d.getDay();  // 0 = Sun
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Mon
  const mon = new Date(d);
  mon.setDate(diff);
  return toDateStr(mon);
};

const getLast90Days = () => {
  const days = [];
  for (let i = 89; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(toDateStr(d));
  }
  return days;
};

// ================================================================
//  FIRESTORE — STREAKS CRUD
// ================================================================
async function loadStreaks() {
  if (!db) return;
  try {
    const snap = await getDocs(collection(db, "streaks"));
    state.streaks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    await Promise.all(state.streaks.map(s => loadCheckins(s.id)));
    renderAll();
  } catch (e) {
    showToast("Lỗi tải dữ liệu", e.message, "error");
  }
}

async function saveStreak(data) {
  if (!db) return null;
  try {
    const ref = await addDoc(collection(db, "streaks"), {
      ...data,
      badges: [],
      createdAt: serverTimestamp(),
    });
    return ref.id;
  } catch (e) {
    showToast("Lỗi lưu streak", e.message, "error");
    return null;
  }
}

async function deleteStreak(streakId) {
  if (!db) return;
  try {
    // Delete checkins sub-collection first
    const checkinsRef = collection(db, "streaks", streakId, "checkins");
    const snap = await getDocs(checkinsRef);
    const delPromises = snap.docs.map(d => deleteDoc(d.ref));
    await Promise.all(delPromises);
    await deleteDoc(doc(db, "streaks", streakId));
    state.streaks = state.streaks.filter(s => s.id !== streakId);
    delete state.checkinsByStreak[streakId];
    renderAll();
    showToast("Đã xóa", "Thói quen đã được xóa thành công", "info");
  } catch (e) {
    showToast("Lỗi xóa", e.message, "error");
  }
}

async function updateStreakFreezes(streakId, newCount) {
  if (!db) return;
  await updateDoc(doc(db, "streaks", streakId), { freezesCount: newCount });
  const s = state.streaks.find(x => x.id === streakId);
  if (s) s.freezesCount = newCount;
}

async function updateStreakBadges(streakId, badges) {
  if (!db) return;
  await updateDoc(doc(db, "streaks", streakId), { badges });
  const s = state.streaks.find(x => x.id === streakId);
  if (s) s.badges = badges;
}

// ================================================================
//  FIRESTORE — CHECKINS
// ================================================================
async function loadCheckins(streakId) {
  if (!db) return;
  try {
    const snap = await getDocs(collection(db, "streaks", streakId, "checkins"));
    const map = {};
    snap.docs.forEach(d => { map[d.id] = d.data(); });
    state.checkinsByStreak[streakId] = map;
  } catch (e) {
    console.error("Load checkins error", e);
  }
}

async function saveCheckin(streakId, dateStr, data) {
  if (!db) return;
  try {
    await setDoc(doc(db, "streaks", streakId, "checkins", dateStr), {
      ...data,
      timestamp: serverTimestamp(),
    });
    if (!state.checkinsByStreak[streakId]) state.checkinsByStreak[streakId] = {};
    state.checkinsByStreak[streakId][dateStr] = data;
  } catch (e) {
    showToast("Lỗi check-in", e.message, "error");
    throw e;
  }
}

// ================================================================
//  STORAGE — IMAGE UPLOAD
// ================================================================
async function uploadImage(streakId, file) {
  if (!storage || !file) return null;
  try {
    const ext  = file.name.split(".").pop();
    const path = `checkins/${streakId}/${Date.now()}.${ext}`;
    const ref  = storageRef(storage, path);
    await uploadBytes(ref, file);
    const url = await getDownloadURL(ref);
    return url;
  } catch (e) {
    showToast("Lỗi upload ảnh", e.message, "error");
    return null;
  }
}

// ================================================================
//  STREAK LOGIC
// ================================================================

/** Tính số streak hiện tại từ map checkins */
function calculateStreak(checkinMap) {
  const today   = toDateStr();
  const sorted  = Object.keys(checkinMap).sort().reverse();
  if (sorted.length === 0) return 0;

  let count = 0;
  let cursor = new Date(today);

  for (let i = 0; i < 365; i++) {
    const ds = toDateStr(cursor);
    if (checkinMap[ds]) {
      count++;
    } else {
      // allow today to be missing (haven't checked in yet)
      if (ds === today && i === 0) {
        cursor.setDate(cursor.getDate() - 1);
        continue;
      }
      break;
    }
    cursor.setDate(cursor.getDate() - 1);
  }
  return count;
}

/** Kiểm tra ngày hôm qua có bị miss không */
function isMissedYesterday(checkinMap) {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const ys = toDateStr(yesterday);
  const today = toDateStr();
  // if today already checked, no need to freeze
  if (checkinMap[today]) return false;
  return !checkinMap[ys];
}

/** Số check-in trong tuần hiện tại */
function checkinsThisWeek(checkinMap) {
  const weekStart = getWeekStart();
  const today     = toDateStr();
  return Object.keys(checkinMap).filter(d => d >= weekStart && d <= today).length;
}

/** Tính tổng số check-in (cho badge) */
function totalCheckins(checkinMap) {
  return Object.keys(checkinMap || {}).length;
}

/** Mở khóa huy hiệu dựa trên chuỗi streak */
async function checkAndUnlockBadges(streak, checkinMap) {
  const streakCount = calculateStreak(checkinMap);
  const current     = streak.badges || [];
  let updated       = [...current];
  let changed       = false;

  const milestones = [
    { days: 7,   id: "badge_7" },
    { days: 30,  id: "badge_30" },
    { days: 100, id: "badge_100" },
  ];

  for (const m of milestones) {
    if (streakCount >= m.days && !updated.includes(m.id)) {
      updated.push(m.id);
      changed = true;
      showToast("🏆 Huy hiệu mới!", `Bạn đã đạt ${m.days} ngày streak!`, "success");
    }
  }

  if (changed) {
    await updateStreakBadges(streak.id, updated);
    streak.badges = updated;
  }
  return updated;
}

// ================================================================
//  RENDER FUNCTIONS
// ================================================================
function renderAll() {
  const container  = document.getElementById("streaks-container");
  const emptyState = document.getElementById("empty-state");

  if (state.streaks.length === 0) {
    container.innerHTML  = "";
    emptyState.classList.remove("hidden");
    emptyState.classList.add("flex");
    updateGlobalUI();
    return;
  }

  emptyState.classList.add("hidden");
  emptyState.classList.remove("flex");

  container.innerHTML = "";
  state.streaks.forEach(streak => {
    const card = buildStreakCard(streak);
    container.appendChild(card);
  });

  updateGlobalUI();
  updateBadgeRibbon();
}

function buildStreakCard(streak) {
  const checkinMap  = state.checkinsByStreak[streak.id] || {};
  const today       = toDateStr();
  const isChecked   = !!checkinMap[today];
  const streakCount = calculateStreak(checkinMap);
  const total       = totalCheckins(checkinMap);

  const card = document.createElement("div");
  card.className = `streak-card ${isChecked ? "checked-today" : ""}`;
  card.dataset.id = streak.id;

  // Category config
  const catConfig = getCatConfig(streak.category);

  // Weekly progress (3_per_week)
  const isWeekly       = streak.frequency === "3_per_week";
  const weekDone        = checkinsThisWeek(checkinMap);
  const weekTarget      = 3;
  const weeklyHTML      = isWeekly ? `
    <div class="mt-2">
      <div class="flex justify-between items-center mb-1">
        <span class="text-xs text-brand-muted">Tuần này</span>
        <span class="text-xs font-bold ${weekDone >= weekTarget ? "text-green-400" : "text-brand-red"}">${weekDone}/${weekTarget} ngày</span>
      </div>
      <div class="weekly-progress-bar">
        <div class="weekly-progress-fill" style="width: ${Math.min(100, (weekDone/weekTarget)*100)}%"></div>
      </div>
    </div>` : "";

  // Freeze display
  const freezes = streak.freezesCount ?? 2;

  card.innerHTML = `
    <div class="streak-card-header">
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 mb-1 flex-wrap">
          <span class="category-chip ${catConfig.cls}">${catConfig.icon} ${streak.category}</span>
          ${isWeekly ? '<span class="text-xs text-brand-dimmer border border-brand-border rounded-md px-2 py-0.5">3×/tuần</span>' : ''}
        </div>
        <h3 class="font-display font-bold text-brand-text text-base leading-tight truncate">${escHtml(streak.title)}</h3>
        ${weeklyHTML}
      </div>
      <div class="flex flex-col items-end gap-2 shrink-0 ml-2">
        <div class="card-actions">
          <button class="btn-icon btn-delete-streak" data-id="${streak.id}" title="Xóa thói quen">
            <i class="fa-solid fa-trash-can text-xs"></i>
          </button>
        </div>
        <div class="text-right">
          <div class="streak-count">
            <span class="streak-count-num">${streakCount}</span>
          </div>
          <div class="text-brand-muted text-xs">ngày 🔥</div>
        </div>
      </div>
    </div>

    <!-- HEATMAP -->
    <div class="heatmap-container">
      <div class="heatmap-label">90 ngày qua</div>
      <div class="heatmap-grid" id="heatmap-${streak.id}"></div>
    </div>

    <!-- CARD FOOTER -->
    <div class="px-4 pb-4 flex items-center justify-between gap-3">
      <div class="flex items-center gap-3 text-xs text-brand-muted">
        <span title="${freezes} thẻ đóng băng còn lại">❄️ ${freezes}</span>
        <span>·</span>
        <span>${total} lần check-in</span>
      </div>
      ${isChecked
        ? `<div class="checkin-done-indicator"><i class="fa-solid fa-circle-check"></i> Đã check-in</div>`
        : `<button class="btn-primary btn-checkin" data-id="${streak.id}" style="padding:8px 16px;font-size:12px;">
            <i class="fa-solid fa-bolt mr-1.5"></i>Check-in
           </button>`
      }
    </div>
  `;

  // Render heatmap after appending
  requestAnimationFrame(() => {
    renderHeatmap(streak.id, checkinMap);
  });

  // Events
  card.querySelector(".btn-delete-streak")?.addEventListener("click", (e) => {
    e.stopPropagation();
    openDeleteModal(streak.id, streak.title);
  });

  card.querySelector(".btn-checkin")?.addEventListener("click", () => {
    openCheckinModal(streak.id);
  });

  return card;
}

// ================================================================
//  HEATMAP RENDERER
// ================================================================
function renderHeatmap(streakId, checkinMap) {
  const container = document.getElementById(`heatmap-${streakId}`);
  if (!container) return;

  const days  = getLast90Days();
  const today = toDateStr();

  container.innerHTML = "";
  days.forEach(dateStr => {
    const cell     = document.createElement("div");
    const checkin  = checkinMap[dateStr];
    const hasNote  = checkin && (checkin.note || checkin.imageUrl);
    const isFrozen = checkin && checkin.frozen;

    cell.className = [
      "heatmap-cell",
      checkin  ? "checked"  : "",
      hasNote  ? "has-note" : "",
      isFrozen ? "frozen"   : "",
      dateStr === today ? "today" : "",
    ].filter(Boolean).join(" ");

    cell.title = `${dateStr}${checkin ? (checkin.note ? ` — ${checkin.note.slice(0,40)}` : " ✓") : ""}`;
    container.appendChild(cell);
  });
}

// ================================================================
//  GLOBAL UI UPDATE
// ================================================================
function updateGlobalUI() {
  // Sum total freeze across all streaks
  const totalFreeze = state.streaks.reduce((sum, s) => sum + (s.freezesCount ?? 0), 0);
  const el = document.getElementById("global-freeze-count");
  if (el) el.textContent = totalFreeze;
}

function updateBadgeRibbon() {
  // Collect all unlocked badges across all streaks
  const unlocked = new Set();
  state.streaks.forEach(s => (s.badges || []).forEach(b => unlocked.add(b)));

  const map = { badge_7: "badge-7", badge_30: "badge-30", badge_100: "badge-100" };
  Object.entries(map).forEach(([key, elId]) => {
    const el = document.getElementById(elId);
    if (!el) return;
    if (unlocked.has(key)) {
      el.classList.add("unlocked");
    } else {
      el.classList.remove("unlocked");
    }
  });
}

// ================================================================
//  ADD STREAK MODAL
// ================================================================
const modalAdd        = document.getElementById("modal-add-streak");
const inputTitle      = document.getElementById("input-title");
const inputFreezes    = document.getElementById("input-freezes");
const inputStartDate  = document.getElementById("input-start-date");
const startDateField  = document.getElementById("start-date-field");

document.getElementById("btn-add-streak").addEventListener("click", () => {
  resetAddModal();
  modalAdd.classList.remove("hidden");
});

document.getElementById("close-add-modal").addEventListener("click",  () => closeAddModal());
document.getElementById("cancel-add-modal").addEventListener("click", () => closeAddModal());
document.getElementById("add-backdrop").addEventListener("click",     () => closeAddModal());

// Show start date for Tình yêu
document.querySelectorAll('input[name="category"]').forEach(radio => {
  radio.addEventListener("change", () => {
    if (radio.value === "Tình yêu") {
      startDateField.classList.remove("hidden");
    } else {
      startDateField.classList.add("hidden");
    }
  });
});

document.getElementById("save-streak-btn").addEventListener("click", async () => {
  const title    = inputTitle.value.trim();
  const category = document.querySelector('input[name="category"]:checked')?.value || "Custom";
  const frequency= document.querySelector('input[name="frequency"]:checked')?.value || "daily";
  const freezes  = parseInt(inputFreezes.value) || 2;
  const startDate= inputStartDate.value || toDateStr();

  if (!title) {
    inputTitle.focus();
    inputTitle.classList.add("border-brand-red");
    showToast("Thiếu tên", "Hãy nhập tên thói quen", "error");
    return;
  }

  const btn = document.getElementById("save-streak-btn");
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1.5"></i>Đang lưu...';

  const data = { title, category, frequency, freezesCount: freezes, startDate, badges: [] };
  const newId = await saveStreak(data);

  if (newId) {
    state.streaks.push({ id: newId, ...data });
    state.checkinsByStreak[newId] = {};
    closeAddModal();
    renderAll();
    showToast("🎉 Thành công!", `Đã tạo thói quen "${title}"`, "success");
  }

  btn.disabled = false;
  btn.innerHTML = '<i class="fa-solid fa-check mr-1.5"></i>Tạo thói quen';
});

function closeAddModal() { modalAdd.classList.add("hidden"); }

function resetAddModal() {
  inputTitle.value    = "";
  inputFreezes.value  = "2";
  inputStartDate.value= "";
  startDateField.classList.add("hidden");
  inputTitle.classList.remove("border-brand-red");
  document.querySelector('input[name="category"][value="Học tập"]')?.click();
  document.querySelector('input[name="frequency"][value="daily"]')?.click();
}

// ================================================================
//  CHECK-IN MODAL
// ================================================================
const modalCheckin = document.getElementById("modal-checkin");

async function openCheckinModal(streakId) {
  const streak     = state.streaks.find(s => s.id === streakId);
  if (!streak) return;

  state.currentStreakId = streakId;
  const checkinMap = state.checkinsByStreak[streakId] || {};

  // Reset form
  resetCheckinModal();

  // Set title
  document.getElementById("checkin-modal-title").textContent = streak.title;

  // Category-specific UI
  const cat = streak.category;
  const catConfig = getCatConfig(cat);
  document.getElementById("checkin-modal-label").textContent = `${catConfig.icon} Check-in — ${cat}`;

  if (cat === "Học tập") {
    document.getElementById("pomodoro-widget").classList.remove("hidden");
    document.getElementById("study-time-field").classList.remove("hidden");
  } else if (cat === "Gym") {
    document.getElementById("image-upload-field").classList.remove("hidden");
    document.getElementById("body-stats-field").classList.remove("hidden");
  } else if (cat === "Tình yêu") {
    const loveBanner = document.getElementById("love-banner");
    loveBanner.classList.remove("hidden");
    const daysTogether = streak.startDate ? daysBetween(streak.startDate, toDateStr()) : 0;
    document.getElementById("love-days-count").textContent = `Đã bên nhau ${daysTogether} ngày ❤️`;
  }

  // Freeze option
  const missed    = isMissedYesterday(checkinMap);
  const hasFreeze = (streak.freezesCount ?? 0) > 0;
  if (missed && hasFreeze) {
    document.getElementById("freeze-option").classList.remove("hidden");
    document.getElementById("freeze-remaining-count").textContent = `(còn ${streak.freezesCount} thẻ)`;
  }

  modalCheckin.classList.remove("hidden");
}

function resetCheckinModal() {
  stopPomodoro();
  resetPomodoroDisplay();

  document.getElementById("pomodoro-widget").classList.add("hidden");
  document.getElementById("study-time-field").classList.add("hidden");
  document.getElementById("image-upload-field").classList.add("hidden");
  document.getElementById("body-stats-field").classList.add("hidden");
  document.getElementById("love-banner").classList.add("hidden");
  document.getElementById("freeze-option").classList.add("hidden");

  document.getElementById("input-note").value         = "";
  document.getElementById("input-study-time").value   = "";
  document.getElementById("input-weight").value       = "";
  document.getElementById("input-distance").value     = "";
  document.getElementById("use-freeze-checkbox").checked = false;

  // Reset image
  document.getElementById("image-preview").classList.add("hidden");
  document.getElementById("upload-area").classList.remove("hidden");
  document.getElementById("input-image").value = "";
  document.getElementById("preview-img").src    = "";
  state.uploadedImageFile = null;
}

document.getElementById("close-checkin-modal").addEventListener("click",  () => closeCheckinModal());
document.getElementById("cancel-checkin-modal").addEventListener("click", () => closeCheckinModal());
document.getElementById("checkin-backdrop").addEventListener("click",     () => closeCheckinModal());

function closeCheckinModal() {
  stopPomodoro();
  modalCheckin.classList.add("hidden");
  state.currentStreakId = null;
}

document.getElementById("save-checkin-btn").addEventListener("click", async () => {
  const streakId = state.currentStreakId;
  if (!streakId) return;

  const streak     = state.streaks.find(s => s.id === streakId);
  const checkinMap = state.checkinsByStreak[streakId] || {};
  const today      = toDateStr();

  if (checkinMap[today]) {
    showToast("Đã check-in", "Bạn đã check-in hôm nay rồi!", "info");
    closeCheckinModal();
    return;
  }

  const btn = document.getElementById("save-checkin-btn");
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1.5"></i>Đang lưu...';

  try {
    // Build checkin data
    const note        = document.getElementById("input-note").value.trim();
    const studyTime   = document.getElementById("input-study-time").value;
    const weight      = document.getElementById("input-weight").value;
    const distance    = document.getElementById("input-distance").value;
    const useFreeze   = document.getElementById("use-freeze-checkbox").checked;

    const checkinData = { note };
    if (studyTime) checkinData.studyTime = parseInt(studyTime);
    if (weight)    checkinData.bodyStats  = { ...(checkinData.bodyStats || {}), weight: parseFloat(weight) };
    if (distance)  checkinData.bodyStats  = { ...(checkinData.bodyStats || {}), distance: parseFloat(distance) };

    // Upload image if present
    if (state.uploadedImageFile) {
      showToast("Đang upload...", "Đang tải ảnh lên...", "info");
      const url = await uploadImage(streakId, state.uploadedImageFile);
      if (url) checkinData.imageUrl = url;
    }

    // Handle freeze for missed yesterday
    if (useFreeze && (streak.freezesCount ?? 0) > 0) {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const ys = toDateStr(yesterday);

      // Save frozen checkin for yesterday
      await saveCheckin(streakId, ys, { note: "❄️ Thẻ đóng băng", frozen: true, timestamp: new Date() });

      // Deduct freeze card
      const newCount = (streak.freezesCount ?? 1) - 1;
      await updateStreakFreezes(streakId, newCount);
      showToast("❄️ Đã dùng thẻ đóng băng", `Chuỗi streak được bảo toàn! Còn ${newCount} thẻ`, "info");
    }

    // Save today's checkin
    await saveCheckin(streakId, today, checkinData);

    // Check badges
    const updatedCheckinMap = state.checkinsByStreak[streakId];
    await checkAndUnlockBadges(streak, updatedCheckinMap);

    closeCheckinModal();
    renderAll();
    showToast("✅ Check-in thành công!", `Tiếp tục chuỗi "${streak.title}" thôi nào!`, "success");
  } catch (e) {
    showToast("Lỗi check-in", e.message, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-check-circle mr-1.5"></i>Check-in hôm nay!';
  }
});

// ================================================================
//  DELETE MODAL
// ================================================================
const modalDelete = document.getElementById("modal-delete");

function openDeleteModal(streakId, title) {
  state.pendingDeleteId = streakId;
  document.getElementById("delete-confirm-text").textContent = `Xóa "${title}"? Hành động này không thể hoàn tác.`;
  modalDelete.classList.remove("hidden");
}

document.getElementById("cancel-delete").addEventListener("click", () => {
  modalDelete.classList.add("hidden");
  state.pendingDeleteId = null;
});

document.getElementById("confirm-delete").addEventListener("click", async () => {
  if (!state.pendingDeleteId) return;
  const btn = document.getElementById("confirm-delete");
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1.5"></i>Đang xóa...';
  await deleteStreak(state.pendingDeleteId);
  modalDelete.classList.add("hidden");
  state.pendingDeleteId = null;
  btn.disabled = false;
  btn.innerHTML = '<i class="fa-solid fa-trash-can mr-1.5"></i>Xóa';
});

// ================================================================
//  POMODORO TIMER
// ================================================================
function startPomodoro() {
  if (state.pomodoroRunning) return;
  state.pomodoroRunning = true;

  const display  = document.getElementById("pomodoro-display");
  const startBtn = document.getElementById("pomodoro-start");
  const pauseBtn = document.getElementById("pomodoro-pause");
  const status   = document.getElementById("pomodoro-status");

  startBtn.classList.add("hidden");
  pauseBtn.classList.remove("hidden");
  display.classList.add("running");
  status.textContent = "🍅 Đang tập trung...";

  state.pomodoroInterval = setInterval(() => {
    if (state.pomodoroSeconds <= 0) {
      clearInterval(state.pomodoroInterval);
      state.pomodoroRunning = false;
      display.classList.remove("running");
      status.textContent = "🎉 Hoàn thành 1 pomodoro!";
      showToast("🍅 Pomodoro xong!", "Nghỉ 5 phút rồi tiếp tục nhé!", "success");
      startBtn.classList.remove("hidden");
      pauseBtn.classList.add("hidden");

      // Auto-fill study time
      const elapsed = Math.round(state.pomodoroElapsed / 60);
      const stField = document.getElementById("input-study-time");
      if (stField && !stField.value) stField.value = elapsed || 25;
      return;
    }
    state.pomodoroSeconds--;
    state.pomodoroElapsed++;
    updatePomodoroDisplay();
  }, 1000);
}

function pausePomodoro() {
  if (!state.pomodoroRunning) return;
  clearInterval(state.pomodoroInterval);
  state.pomodoroRunning = false;
  document.getElementById("pomodoro-display").classList.remove("running");
  document.getElementById("pomodoro-start").classList.remove("hidden");
  document.getElementById("pomodoro-pause").classList.add("hidden");
  document.getElementById("pomodoro-status").textContent = "⏸ Đã tạm dừng";
}

function stopPomodoro() {
  clearInterval(state.pomodoroInterval);
  state.pomodoroRunning = false;
}

function resetPomodoroDisplay() {
  state.pomodoroSeconds = 25 * 60;
  state.pomodoroElapsed = 0;
  state.pomodoroRunning = false;
  clearInterval(state.pomodoroInterval);
  updatePomodoroDisplay();
  const display  = document.getElementById("pomodoro-display");
  const startBtn = document.getElementById("pomodoro-start");
  const pauseBtn = document.getElementById("pomodoro-pause");
  const status   = document.getElementById("pomodoro-status");
  if (display)  display.classList.remove("running");
  if (startBtn) startBtn.classList.remove("hidden");
  if (pauseBtn) pauseBtn.classList.add("hidden");
  if (status)   status.textContent = "";
}

function updatePomodoroDisplay() {
  const m = Math.floor(state.pomodoroSeconds / 60).toString().padStart(2, "0");
  const s = (state.pomodoroSeconds % 60).toString().padStart(2, "0");
  const el = document.getElementById("pomodoro-display");
  if (el) el.textContent = `${m}:${s}`;
}

document.getElementById("pomodoro-start").addEventListener("click", startPomodoro);
document.getElementById("pomodoro-pause").addEventListener("click", pausePomodoro);
document.getElementById("pomodoro-reset").addEventListener("click", () => {
  stopPomodoro();
  resetPomodoroDisplay();
  document.getElementById("pomodoro-status").textContent = "";
});

// ================================================================
//  IMAGE UPLOAD HANDLING
// ================================================================
const uploadArea  = document.getElementById("upload-area");
const inputImage  = document.getElementById("input-image");
const imagePreview= document.getElementById("image-preview");
const previewImg  = document.getElementById("preview-img");

uploadArea.addEventListener("click", () => inputImage.click());

uploadArea.addEventListener("dragover", (e) => {
  e.preventDefault();
  uploadArea.classList.add("drag-over");
});
uploadArea.addEventListener("dragleave", () => uploadArea.classList.remove("drag-over"));
uploadArea.addEventListener("drop", (e) => {
  e.preventDefault();
  uploadArea.classList.remove("drag-over");
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith("image/")) handleImageSelect(file);
});

inputImage.addEventListener("change", () => {
  const file = inputImage.files[0];
  if (file) handleImageSelect(file);
});

function handleImageSelect(file) {
  state.uploadedImageFile = file;
  const reader = new FileReader();
  reader.onload = (e) => {
    previewImg.src = e.target.result;
    imagePreview.classList.remove("hidden");
    uploadArea.classList.add("hidden");
  };
  reader.readAsDataURL(file);
}

document.getElementById("remove-img").addEventListener("click", () => {
  state.uploadedImageFile = null;
  inputImage.value  = "";
  previewImg.src    = "";
  imagePreview.classList.add("hidden");
  uploadArea.classList.remove("hidden");
});

// ================================================================
//  CATEGORY CONFIG HELPER
// ================================================================
function getCatConfig(category) {
  const map = {
    "Học tập":  { icon: "📚", cls: "study" },
    "Gym":      { icon: "💪", cls: "gym" },
    "Tình yêu": { icon: "❤️", cls: "love" },
    "Custom":   { icon: "✨", cls: "custom" },
  };
  return map[category] || map["Custom"];
}

// ================================================================
//  TOAST NOTIFICATION
// ================================================================
function showToast(title, message, type = "info") {
  const container = document.getElementById("toast-container");
  const icons = { success: "✅", error: "❌", info: "ℹ️" };

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <div class="toast-icon">${icons[type] || "ℹ️"}</div>
    <div class="toast-body">
      <div class="toast-title">${escHtml(title)}</div>
      ${message ? `<div class="toast-msg">${escHtml(message)}</div>` : ""}
    </div>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("hiding");
    setTimeout(() => toast.remove(), 320);
  }, 3800);
}

// ================================================================
//  UTILS
// ================================================================
function escHtml(str) {
  if (!str) return "";
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// Keyboard — close modals on Escape
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!modalAdd.classList.contains("hidden"))     closeAddModal();
    if (!modalCheckin.classList.contains("hidden")) closeCheckinModal();
    if (!modalDelete.classList.contains("hidden")) {
      modalDelete.classList.add("hidden");
      state.pendingDeleteId = null;
    }
  }
});

// ================================================================
//  BOOT
// ================================================================
(async function boot() {
  // Set today as default start date
  const todayStr = toDateStr();
  if (inputStartDate) inputStartDate.value = todayStr;

  // Select defaults
  document.querySelector('input[name="category"][value="Học tập"]')?.click();
  document.querySelector('input[name="frequency"][value="daily"]')?.click();

  if (!db) {
    // Demo mode — show empty state with config notice
    showToast(
      "⚙️ Cấu hình Firebase",
      "Hãy điền firebaseConfig trong app.js để bắt đầu",
      "info"
    );
    document.getElementById("empty-state").classList.remove("hidden");
    document.getElementById("empty-state").classList.add("flex");
    return;
  }

  await loadStreaks();
})();
