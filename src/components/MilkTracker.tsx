import { useState, useEffect, useCallback, useRef } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import {
  formatTime,
  formatDate,
  formatDatePill,
  todayStr,
  todayIsoDate,
  formatCountdown,
  formatElapsed,
  toTimeInputValue,
  todayTimeInputToTimestamp,
} from "../lib/format";
import type {
  FamilyInfo,
  Feeding,
  FeedingRow,
  MilkType,
  BabyMeasurement,
  BabyMeasurementRow,
} from "../types/database";
import { rowToFeeding, feedingDisplayNote, rowToBabyMeasurement } from "../types/database";
import { usePushNotifications } from "../hooks/usePushNotifications";
import { showLocalNotification } from "../lib/push";
import PumpTracker from "./PumpTracker";
import "../App.css";
import "../Auth.css";

const FEED_INTERVAL_MS = 2 * 60 * 60 * 1000;
const PREPARE_WARN_MS = 60 * 60 * 1000;
const QUICK_OZ = [2, 2.5, 3, 3.5, 4];
const MILK_TYPES = ["FM", "EBM", "BM"] as const;
const FORGOT_AGO_MIN = [15, 30, 45, 60] as const;
const FRIDGE_EBM_STEP = 1;

type Status = "none" | "ok" | "prepare" | "overdue";

function getStatus(lastTs: number | null, now: number): Status {
  if (!lastTs) return "none";
  const remaining = FEED_INTERVAL_MS - (now - lastTs);
  if (remaining < 0) return "overdue";
  if (remaining <= PREPARE_WARN_MS) return "prepare";
  return "ok";
}

function dayMilkTotals(items: Feeding[]) {
  return items.reduce(
    (acc, f) => {
      acc.total += f.oz;
      if (f.milkType === "EBM") acc.ebm += f.oz;
      else if (f.milkType === "FM") acc.fm += f.oz;
      return acc;
    },
    { total: 0, ebm: 0, fm: 0 },
  );
}

function isMissingTableError(message: string) {
  return (
    message.includes("does not exist") ||
    message.includes("schema cache") ||
    message.includes("Could not find the table") ||
    message.includes("Could not find the column")
  );
}

function fridgeStorageKey(familyId: string) {
  return `fridge-ebm-${familyId}`;
}

interface StoredFridge {
  count: number;
  updatedAt: number | null;
}

function readStoredFridge(familyId: string): StoredFridge {
  try {
    const raw = localStorage.getItem(fridgeStorageKey(familyId));
    if (raw == null) return { count: 0, updatedAt: null };
    try {
      const parsed = JSON.parse(raw) as StoredFridge;
      if (parsed && typeof parsed.count === "number") {
        return {
          count: parsed.count >= 0 ? parsed.count : 0,
          updatedAt:
            typeof parsed.updatedAt === "number" ? parsed.updatedAt : null,
        };
      }
    } catch {
      /* legacy plain number string */
    }
    const n = parseInt(raw, 10);
    return {
      count: Number.isFinite(n) && n >= 0 ? n : 0,
      updatedAt: null,
    };
  } catch {
    return { count: 0, updatedAt: null };
  }
}

function writeStoredFridge(familyId: string, data: StoredFridge) {
  try {
    localStorage.setItem(fridgeStorageKey(familyId), JSON.stringify(data));
  } catch {
    /* ignore quota / private mode */
  }
}

function appetonStorageKey(familyId: string) {
  return `appeton-logs-${familyId}`;
}

function isoDateToDateKey(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toDateString();
}

function dateKeyToIso(dateKey: string): string {
  return new Date(dateKey).toLocaleDateString("en-CA");
}

function readStoredAppetonLogs(familyId: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(appetonStorageKey(familyId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, number>;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

function writeStoredAppetonLogs(familyId: string, logs: Record<string, number>) {
  try {
    localStorage.setItem(appetonStorageKey(familyId), JSON.stringify(logs));
  } catch {
    /* ignore */
  }
}

type ActivityItem =
  | { kind: "feeding"; feeding: Feeding }
  | { kind: "appeton"; timestamp: number };

function buildActivityList(
  feedings: Feeding[],
  appetonTs: number | null,
): ActivityItem[] {
  const items: ActivityItem[] = feedings.map((feeding) => ({
    kind: "feeding",
    feeding,
  }));
  if (appetonTs != null) {
    items.push({ kind: "appeton", timestamp: appetonTs });
  }
  return items.sort((a, b) => {
    const ta = a.kind === "feeding" ? a.feeding.timestamp : a.timestamp;
    const tb = b.kind === "feeding" ? b.feeding.timestamp : b.timestamp;
    return ta - tb;
  });
}

interface Props {
  session: Session;
  family: FamilyInfo;
  onSignOut: () => void;
  showSignOut?: boolean;
}

export default function MilkTracker({
  session,
  family,
  onSignOut,
  showSignOut = true,
}: Props) {
  const [feedings, setFeedings] = useState<Feeding[]>([]);
  const [loading, setLoading] = useState(true);
  const [oz, setOz] = useState("2.5");
  const [milkType, setMilkType] = useState<MilkType | "">("FM");
  const [note, setNote] = useState("");
  const [now, setNow] = useState(Date.now());
  const [justLogged, setJustLogged] = useState(false);
  const [activeTab, setActiveTab] = useState<"today" | "history">("today");
  const [selectedDateKey, setSelectedDateKey] = useState(todayStr());
  const [person, setPerson] = useState<"anaqi" | "mummy">("anaqi");
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotTime, setForgotTime] = useState(() =>
    toTimeInputValue(Date.now() - 30 * 60 * 1000),
  );
  const [error, setError] = useState("");
  const [latestMeasurement, setLatestMeasurement] = useState<BabyMeasurement | null>(null);
  const [growthOpen, setGrowthOpen] = useState(false);
  const storedFridge = readStoredFridge(family.familyId);
  const [fridgeEbmCount, setFridgeEbmCount] = useState(storedFridge.count);
  const [fridgeUpdatedAt, setFridgeUpdatedAt] = useState<number | null>(
    storedFridge.updatedAt,
  );
  const [fridgeUpdating, setFridgeUpdating] = useState(false);
  const fridgeEbmRef = useRef(fridgeEbmCount);
  const fridgeUpdatedAtRef = useRef(fridgeUpdatedAt);
  const fridgeUpdatingRef = useRef(false);
  const [appetonLogs, setAppetonLogs] = useState<Record<string, number>>(
    () => readStoredAppetonLogs(family.familyId),
  );
  const [appetonSaving, setAppetonSaving] = useState(false);
  const appetonDoneToday = appetonLogs[todayStr()] != null;
  const { notiStatus, notiError, iosHint, enableNotifications } = usePushNotifications(
    session.user.id,
  );

  const persistFridge = useCallback(
    (count: number, updatedAt: number | null) => {
      fridgeEbmRef.current = count;
      fridgeUpdatedAtRef.current = updatedAt;
      setFridgeEbmCount(count);
      setFridgeUpdatedAt(updatedAt);
      writeStoredFridge(family.familyId, { count, updatedAt });
    },
    [family.familyId],
  );

  useEffect(() => {
    fridgeEbmRef.current = fridgeEbmCount;
  }, [fridgeEbmCount]);

  useEffect(() => {
    fridgeUpdatedAtRef.current = fridgeUpdatedAt;
  }, [fridgeUpdatedAt]);

  const fetchGrowth = useCallback(async () => {
    const { data, error: fetchError } = await supabase
      .from("baby_measurements")
      .select("*")
      .order("measured_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (fetchError) {
      if (!isMissingTableError(fetchError.message)) {
        setError(fetchError.message);
      }
      return;
    }

    setLatestMeasurement(
      data ? rowToBabyMeasurement(data as BabyMeasurementRow) : null,
    );
  }, []);

  const fetchFridgeEbm = useCallback(async () => {
    if (fridgeUpdatingRef.current) return;

    const { data, error: fetchError } = await supabase
      .from("family_fridge")
      .select("ebm_count, updated_at")
      .eq("family_id", family.familyId)
      .maybeSingle();

    if (fetchError) {
      if (!isMissingTableError(fetchError.message)) {
        setError(fetchError.message);
      }
      return;
    }

    if (data == null) return;

    const fromDb = Number(data.ebm_count);
    if (!Number.isFinite(fromDb) || fromDb < 0) return;

    const updatedAt = data.updated_at
      ? new Date(data.updated_at).getTime()
      : null;
    persistFridge(fromDb, updatedAt);
  }, [family.familyId, persistFridge]);

  const fetchAppeton = useCallback(async () => {
    const { data, error: fetchError } = await supabase
      .from("daily_appeton")
      .select("log_date, logged_at")
      .eq("family_id", family.familyId)
      .order("log_date", { ascending: false });

    if (fetchError) {
      if (!isMissingTableError(fetchError.message)) {
        setError(fetchError.message);
      }
      return;
    }

    const fromDb: Record<string, number> = {};
    for (const row of data ?? []) {
      fromDb[isoDateToDateKey(row.log_date as string)] = new Date(
        row.logged_at as string,
      ).getTime();
    }

    setAppetonLogs((prev) => {
      const merged = { ...readStoredAppetonLogs(family.familyId), ...prev, ...fromDb };
      writeStoredAppetonLogs(family.familyId, merged);
      return merged;
    });
  }, [family.familyId]);

  const markAppetonDone = useCallback(async () => {
    const today = todayIsoDate();
    const loggedAt = Date.now();
    const dateKey = todayStr();

    setAppetonSaving(true);
    setAppetonLogs((prev) => {
      const next = { ...prev, [dateKey]: loggedAt };
      writeStoredAppetonLogs(family.familyId, next);
      return next;
    });
    setError("");

    const { error: insertError } = await supabase.from("daily_appeton").insert({
      family_id: family.familyId,
      log_date: today,
      logged_at: new Date(loggedAt).toISOString(),
      logged_by: session.user.id,
    });

    setAppetonSaving(false);

    if (insertError) {
      if (
        !isMissingTableError(insertError.message) &&
        !insertError.message.includes("duplicate key")
      ) {
        setError(insertError.message);
      }
    }
  }, [family.familyId, session.user.id]);

  const removeAppeton = useCallback(
    async (dateKey: string) => {
      const snapshot = { ...appetonLogs };
      setAppetonLogs((prev) => {
        const next = { ...prev };
        delete next[dateKey];
        writeStoredAppetonLogs(family.familyId, next);
        return next;
      });
      setError("");

      const { error: deleteError } = await supabase
        .from("daily_appeton")
        .delete()
        .eq("family_id", family.familyId)
        .eq("log_date", dateKeyToIso(dateKey));

      if (deleteError && !isMissingTableError(deleteError.message)) {
        setAppetonLogs(snapshot);
        writeStoredAppetonLogs(family.familyId, snapshot);
        setError(deleteError.message);
      }
    },
    [appetonLogs, family.familyId],
  );

  const fetchFeedings = useCallback(async () => {
    const { data, error: fetchError } = await supabase
      .from("feedings")
      .select("*")
      .order("logged_at", { ascending: true });

    if (fetchError) {
      setError(fetchError.message);
      return;
    }

    setFeedings((data as FeedingRow[]).map(rowToFeeding));
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchFeedings();
    fetchGrowth();
    fetchFridgeEbm();
    fetchAppeton();

    const feedingsChannel = supabase
      .channel("feedings-changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "feedings" },
        () => fetchFeedings(),
      )
      .subscribe();

    const growthChannel = supabase
      .channel("baby-measurements-changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "baby_measurements" },
        () => fetchGrowth(),
      )
      .subscribe();

    const fridgeChannel = supabase
      .channel("family-fridge-changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "family_fridge" },
        () => fetchFridgeEbm(),
      )
      .subscribe();

    const appetonChannel = supabase
      .channel("daily-appeton-changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "daily_appeton" },
        () => fetchAppeton(),
      )
      .subscribe();

    return () => {
      supabase.removeChannel(feedingsChannel);
      supabase.removeChannel(growthChannel);
      supabase.removeChannel(fridgeChannel);
      supabase.removeChannel(appetonChannel);
    };
  }, [fetchFeedings, fetchGrowth, fetchFridgeEbm, fetchAppeton]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const lastFeeding =
    feedings.length > 0 ? feedings[feedings.length - 1] : null;
  const nextFeedTs = lastFeeding
    ? lastFeeding.timestamp + FEED_INTERVAL_MS
    : null;
  const remaining = nextFeedTs ? nextFeedTs - now : null;
  const status = getStatus(lastFeeding?.timestamp ?? null, now);
  const countdown = remaining !== null ? formatCountdown(remaining) : null;

  const todayFeedings = feedings.filter(
    (f) => new Date(f.timestamp).toDateString() === todayStr(),
  );
  const dailyOz = todayFeedings.reduce((s, f) => s + f.oz, 0);
  const todayEbmOz = todayFeedings
    .filter((f) => f.milkType === "EBM")
    .reduce((s, f) => s + f.oz, 0);
  const todayFmOz = todayFeedings
    .filter((f) => f.milkType === "FM")
    .reduce((s, f) => s + f.oz, 0);

  const pastFeedings = feedings.filter(
    (f) => new Date(f.timestamp).toDateString() !== todayStr(),
  );
  const grouped = pastFeedings.reduce<Record<string, Feeding[]>>((acc, f) => {
    const k = new Date(f.timestamp).toDateString();
    (acc[k] ??= []).push(f);
    return acc;
  }, {});
  const pastDates = Object.keys(grouped).sort(
    (a, b) => new Date(b).getTime() - new Date(a).getTime(),
  );

  const allDateKeys = [...new Set(feedings.map((f) => new Date(f.timestamp).toDateString()))].sort(
    (a, b) => new Date(b).getTime() - new Date(a).getTime(),
  );

  const historyDateKeys =
    activeTab === "today" ? [todayStr()] : allDateKeys.filter((k) => k !== todayStr());

  const visibleDateKeys = activeTab === "today" ? [todayStr()] : historyDateKeys.length > 0 ? historyDateKeys : allDateKeys;

  const selectedFeedings = feedings.filter(
    (f) => new Date(f.timestamp).toDateString() === selectedDateKey,
  );
  const selectedTotal = selectedFeedings.reduce((s, f) => s + f.oz, 0);
  const selectedMilk = dayMilkTotals(selectedFeedings);
  const selectedAppetonTs = appetonLogs[selectedDateKey] ?? null;
  const selectedActivity = buildActivityList(
    selectedFeedings,
    selectedAppetonTs,
  );
  const hasSelectedActivity = selectedActivity.length > 0;

  const logFeeding = useCallback(
    async (loggedAtTs: number) => {
      const parsed = parseFloat(oz);
      if (!parsed || parsed <= 0 || parsed > 10) return;

      setError("");
      const { error: insertError } = await supabase.from("feedings").insert({
        family_id: family.familyId,
        logged_at: new Date(loggedAtTs).toISOString(),
        oz: parsed,
        milk_type: milkType || null,
        note: note.trim() || null,
        logged_by: session.user.id,
      });

      if (insertError) {
        setError(insertError.message);
        return;
      }

      setNote("");
      setForgotOpen(false);
      setJustLogged(true);
      setTimeout(() => setJustLogged(false), 2000);
      fetchFeedings();

      const noteParts = [milkType, note.trim()].filter(Boolean).join(" · ");
      await showLocalNotification(
        "🍼 Feed logged",
        `Logged at ${formatTime(loggedAtTs)} · ${parsed}oz${noteParts ? ` · ${noteParts}` : ""}`,
        "anaqi-feed-logged",
      );
    },
    [oz, milkType, note, family.familyId, session.user.id, fetchFeedings],
  );

  const removeFeeding = useCallback(
    async (id: string) => {
      const { error: deleteError } = await supabase
        .from("feedings")
        .delete()
        .eq("id", id);
      if (deleteError) setError(deleteError.message);
      else fetchFeedings();
    },
    [fetchFeedings],
  );

  const adjustFridgeEbm = useCallback(
    async (delta: number) => {
      const prev = fridgeEbmRef.current;
      const prevUpdatedAt = fridgeUpdatedAtRef.current;
      const next = Math.max(0, prev + delta);
      if (next === prev) return;

      const updatedAt = Date.now();
      fridgeUpdatingRef.current = true;
      setFridgeUpdating(true);
      persistFridge(next, updatedAt);
      setError("");

      const { error: upsertError } = await supabase.from("family_fridge").upsert(
        {
          family_id: family.familyId,
          ebm_count: next,
          updated_at: new Date(updatedAt).toISOString(),
        },
        { onConflict: "family_id" },
      );

      fridgeUpdatingRef.current = false;
      setFridgeUpdating(false);

      if (upsertError) {
        if (isMissingTableError(upsertError.message)) {
          return;
        }
        persistFridge(prev, prevUpdatedAt);
        setError(upsertError.message);
      }
    },
    [family.familyId, persistFridge],
  );

  const forgotTs = todayTimeInputToTimestamp(forgotTime);
  const forgotValid =
    forgotTs <= Date.now() &&
    (!lastFeeding || forgotTs > lastFeeding.timestamp);

  if (loading) {
    return (
      <div className="auth-page">
        <div className="loading-spinner">🍼</div>
      </div>
    );
  }

  return (
    <div className={`app ${person === "mummy" ? "app-mummy" : ""}`}>
      <div className="header-top">
        <header className="header" style={{ marginBottom: 0 }}>
          <img
            src={person === "mummy" ? "/mummy.png" : "/icon.png"}
            alt={person === "mummy" ? "Mummy" : "Anaqi"}
            className="auth-icon"
            style={{ width: 48, height: 48, marginBottom: 0 }}
          />
          <div>
            <h1 className="header-title">
              {person === "anaqi" ? "Anaqi Idris's Susu" : "Mummy's Pump"}
            </h1>
            <p className="header-sub">
              {new Date().toLocaleDateString("en-MY", {
                weekday: "long",
                day: "numeric",
                month: "long",
              })}
            </p>
          </div>
        </header>
        <div className="header-actions">
          <span className="invite-pill">Code: {family.inviteCode}</span>
          {notiStatus === "on" ? (
            <span className="noti-on-pill">🔔 On</span>
          ) : (
            <button
              type="button"
              className="noti-btn"
              onClick={enableNotifications}
            >
              🔔 Enable alerts
            </button>
          )}
          {showSignOut && (
            <button type="button" className="sign-out-btn" onClick={onSignOut}>
              Sign out
            </button>
          )}
        </div>
      </div>

      <div className="person-tabs">
        <button
          type="button"
          className={`person-tab ${person === "anaqi" ? "active" : ""}`}
          onClick={() => setPerson("anaqi")}
        >
          👶 Idris
        </button>
        <button
          type="button"
          className={`person-tab ${person === "mummy" ? "active" : ""}`}
          onClick={() => setPerson("mummy")}
        >
          🤱 Mummy
        </button>
      </div>

      {person === "mummy" ? (
        <PumpTracker session={session} family={family} />
      ) : (
        <>
          {error && (
            <p className="auth-error" style={{ marginBottom: "0.75rem" }}>
              {error}
            </p>
          )}
          {iosHint && notiStatus !== "on" && (
            <div className="ios-noti-hint">
              <span>📱</span>
              <span>{iosHint}</span>
            </div>
          )}
          {notiError && (
            <p className="auth-error" style={{ marginBottom: "0.75rem" }}>
              {notiError}
            </p>
          )}

          <div className={`growth-collapse ${growthOpen ? "open" : ""}`}>
            <button
              type="button"
              className="growth-collapse-toggle"
              onClick={() => setGrowthOpen((open) => !open)}
              aria-expanded={growthOpen}
            >
              <span className="growth-collapse-title">Growth</span>
              <span className="growth-collapse-summary">
                {latestMeasurement?.weightKg != null ? (
                  <>
                    {latestMeasurement.weightKg} kg
                    <span className="growth-collapse-date">
                      · {formatDate(latestMeasurement.measuredAt)}
                    </span>
                  </>
                ) : (
                  "No data yet"
                )}
              </span>
              <span className="growth-collapse-chevron" aria-hidden>
                {growthOpen ? "▾" : "▸"}
              </span>
            </button>
            {growthOpen && (
              <div className="growth-collapse-body">
                <div className="growth-collapse-stats">
                  <div className="stat-box">
                    <span className="stat-value">
                      {latestMeasurement?.weightKg != null
                        ? latestMeasurement.weightKg
                        : "—"}
                    </span>
                    <span className="stat-unit">kg</span>
                    <p className="stat-label">Weight</p>
                  </div>
                  <div className="stat-box">
                    <span className="stat-value">
                      {latestMeasurement?.heightCm != null
                        ? latestMeasurement.heightCm
                        : "—"}
                    </span>
                    <span className="stat-unit">cm</span>
                    <p className="stat-label">Length</p>
                  </div>
                </div>
                {latestMeasurement && (
                  <p className="growth-measured-date">
                    Weight as of {formatDate(latestMeasurement.measuredAt)}
                  </p>
                )}
              </div>
            )}
          </div>

          <div className={`card countdown-card status-${status}`}>
            {status === "none" && (
              <>
                <p className="cd-label">No feedings yet</p>
                <p className="cd-time">—</p>
                <p className="cd-sub">Log the first feeding below</p>
              </>
            )}

            {status === "ok" &&
              lastFeeding &&
              nextFeedTs &&
              (() => {
                const prepareTs =
                  lastFeeding.timestamp + FEED_INTERVAL_MS - PREPARE_WARN_MS;
                const cd = formatCountdown(prepareTs - now);
                return (
                  <>
                    <p className="cd-label">Prep susu sebelum idris nangis</p>
                    <p className="cd-time">
                      {cd.h > 0 && (
                        <>
                          <span>{cd.h}</span>
                          <small>h </small>
                        </>
                      )}
                      <span>{cd.m}</span>
                      <small> m</small>
                    </p>
                    <div className="cd-rows">
                      <div className="cd-row">
                        <span>Standby susu </span>
                        <span>{formatTime(nextFeedTs - PREPARE_WARN_MS)}</span>
                      </div>
                      <div className="cd-row">
                        <span>Next feed in</span>
                        <span>{formatTime(nextFeedTs)}</span>
                      </div>
                      <div className="cd-row">
                        <span>Last fed</span>
                        <span>{formatTime(lastFeeding.timestamp)}</span>
                      </div>
                    </div>
                  </>
                );
              })()}

            {status === "prepare" && countdown && nextFeedTs && (
              <>
                <p className="cd-label">🍼 Prepare Now!</p>
                <p className="cd-time">
                  {countdown.h > 0 && (
                    <>
                      <span>{countdown.h}</span>
                      <small>h </small>
                    </>
                  )}
                  <span>{countdown.m}</span>
                  <small>m</small>
                </p>
                <p className="cd-sub">
                  next feed {formatTime(nextFeedTs)} · {countdown.m}m away
                </p>
              </>
            )}

            {status === "overdue" && countdown && lastFeeding && (
              <>
                <p className="cd-label">Feeding overdue!</p>
                <p className="cd-time">
                  +
                  {countdown.h > 0 && (
                    <>
                      <span>{countdown.h}</span>
                      <small>h </small>
                    </>
                  )}
                  <span>{countdown.m}</span>
                  <small>m</small>
                </p>
                <p className="cd-sub">
                  last fed {formatTime(lastFeeding.timestamp)} ·{" "}
                  {formatElapsed(now - lastFeeding.timestamp)}
                </p>
              </>
            )}
          </div>

          {status === "prepare" && (
            <div className="prepare-banner">
              <span className="prepare-icon">⏱️</span>
              <span>
                Time to bancuh & panaskan susu - and ready to feed him{" "}
              </span>
            </div>
          )}

          <div className="fridge-ebm-card">
            <p className="fridge-ebm-label">Total EBM in fridge</p>
            <div className="fridge-ebm-controls">
              <button
                type="button"
                className="fridge-ebm-btn"
                disabled={fridgeUpdating || fridgeEbmCount <= 0}
                onClick={() => adjustFridgeEbm(-FRIDGE_EBM_STEP)}
                aria-label="Decrease fridge EBM"
              >
                −
              </button>
              <div className="fridge-ebm-value">
                <span className="fridge-ebm-num">{fridgeEbmCount}</span>
              </div>
              <button
                type="button"
                className="fridge-ebm-btn"
                disabled={fridgeUpdating}
                onClick={() => adjustFridgeEbm(FRIDGE_EBM_STEP)}
                aria-label="Increase fridge EBM"
              >
                +
              </button>
            </div>
            {fridgeUpdatedAt != null && (
              <p className="fridge-ebm-date">
                Updated {formatDate(fridgeUpdatedAt)} · {formatTime(fridgeUpdatedAt)}
              </p>
            )}
          </div>

          <div className="stats-row">
            <div className="stat-box">
              <span className="stat-value">{dailyOz.toFixed(1)}</span>
              <span className="stat-unit">oz</span>
              <p className="stat-label">Today's total</p>
            </div>
            <div className="stat-box">
              <span className="stat-value">{todayFeedings.length}</span>
              <p className="stat-label">Feedings</p>
            </div>
            
          </div>
          <div className="stats-row stats-row-milk">
            <div className="stat-box">
              <span className="stat-value">{todayEbmOz.toFixed(1)}</span>
              <span className="stat-unit">oz</span>
              <p className="stat-label">EBM today</p>
            </div>
            <div className="stat-box">
              <span className="stat-value">{todayFmOz.toFixed(1)}</span>
              <span className="stat-unit">oz</span>
              <p className="stat-label">FM today</p>
            </div>
          </div>
          <div className="stats-row stats-row-secondary">
            <div className="stat-box">
              <span className="stat-value">
                {lastFeeding ? formatTime(lastFeeding.timestamp) : "—"}
              </span>
              <p className="stat-label">Last fed</p>
            </div>
            <div className="stat-box">
              <span className="stat-value">
                {nextFeedTs ? formatTime(nextFeedTs) : "—"}
              </span>
              <p className="stat-label">Next feed</p>
            </div>
          </div>

    

          <div className="card log-card">
            <h2 className="card-title">Berapa banyak Idris minum??</h2>

            <p className="section-label">Amount</p>
            <div className="oz-row">
              {QUICK_OZ.map((q) => (
                <button
                  key={q}
                  type="button"
                  className={`oz-btn ${oz === String(q) ? "active" : ""}`}
                  onClick={() => setOz(String(q))}
                >
                  {q}oz
                </button>
              ))}
            </div>

            <div className="custom-row">
              <input
                type="number"
                className="oz-input"
                value={oz}
                onChange={(e) => setOz(e.target.value)}
                min="0.5"
                max="10"
                step="0.5"
                inputMode="decimal"
                aria-label="Custom oz amount"
              />
              <span className="oz-unit">oz</span>
            </div>

            <p className="section-label">Susu type</p>
            <div className="milk-type-row">
              {MILK_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`milk-btn ${milkType === t ? "active" : ""}`}
                  onClick={() => setMilkType((prev) => (prev === t ? "" : t))}
                >
                  {t}
                </button>
              ))}
            </div>

            {!appetonDoneToday && (
              <button
                type="button"
                className="appeton-btn"
                disabled={appetonSaving}
                onClick={markAppetonDone}
              >
                {appetonSaving ? "Saving…" : "💊 Appeton"}
              </button>
            )}

            <input
              type="text"
              className="note-input"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="remark"
              maxLength={80}
            />
{/* 
            {lastFeeding && (
              <div className="time-preview">
                <span className="time-preview-label">Last fed was</span>
                <span className="time-preview-val">
                  {formatTime(lastFeeding.timestamp)}
                </span>
                <span className="time-preview-next">→ next feed</span>

                <span>
                  {formatTime(lastFeeding.timestamp + FEED_INTERVAL_MS)}
                </span>
              </div>
            )} */}

            <button
              type="button"
              className={`log-btn ${justLogged ? "logged" : ""}`}
              onClick={() => logFeeding(Date.now())}
            >
              {justLogged ? "✓ Logged!" : "🍼 Log Feed Now"}
            </button>

            <button
              type="button"
              className="forgot-toggle"
              onClick={() => setForgotOpen((open) => !open)}
            >
              {forgotOpen ? "Hide" : "Forgot to log?"}
            </button>

            {forgotOpen && (
              <div className="forgot-panel">
                <p className="section-label">When did you feed him?</p>
                <div className="oz-row">
                  {FORGOT_AGO_MIN.map((m) => (
                    <button
                      key={m}
                      type="button"
                      className="oz-btn forgot-ago-btn"
                      onClick={() =>
                        setForgotTime(
                          toTimeInputValue(Date.now() - m * 60 * 1000),
                        )
                      }
                    >
                      {m}m ago
                    </button>
                  ))}
                </div>
                <div className="custom-row">
                  <input
                    type="time"
                    className="oz-input forgot-time-input"
                    value={forgotTime}
                    onChange={(e) => setForgotTime(e.target.value)}
                    aria-label="Feed time"
                  />
                </div>
                {nextFeedTs && (
                  <p className="forgot-hint">
                    Masa susu sepatutnya {formatTime(nextFeedTs)}
                  </p>
                )}
                {!forgotValid && lastFeeding && (
                  <p className="forgot-error">
                    Ambil masa lepas {formatTime(lastFeeding.timestamp)} and not before
                  </p>
                )}
                <div className="time-preview">
                  <span className="time-preview-label">So jadinya</span>
                    <span className="time-preview-val">
                      {oz}oz at {formatTime(forgotTs)}
                    </span>
                    <span className="time-preview-next">
                      → next feed ~{formatTime(forgotTs + FEED_INTERVAL_MS)}
                    </span>
                </div>
                <button
                  type="button"
                  className="log-btn log-btn-missed"
                  disabled={!forgotValid}
                  onClick={() => logFeeding(forgotTs)}
                >
                  Log {oz}oz at {formatTime(forgotTs)}
                </button>
              </div>
            )}
          </div>

          <div className="tabs">
            <button
              type="button"
              className={`tab-btn ${activeTab === "today" ? "active" : ""}`}
              onClick={() => {
                setActiveTab("today");
                setSelectedDateKey(todayStr());
              }}
            >
              Today
              {todayFeedings.length > 0 && (
                <span className="tab-badge">{todayFeedings.length}</span>
              )}
            </button>
            <button
              type="button"
              className={`tab-btn ${activeTab === "history" ? "active" : ""}`}
              onClick={() => {
                setActiveTab("history");
                const firstPast = allDateKeys.find((k) => k !== todayStr());
                setSelectedDateKey(firstPast ?? todayStr());
              }}
            >
              History
              {pastDates.length > 0 && (
                <span className="tab-badge">{pastDates.length}</span>
              )}
            </button>
          </div>

          <div className="card history-card">
            {activeTab === "history" && pastDates.length === 0 ? (
              <p className="empty-state">No past feedings recorded.</p>
            ) : (
              <>
                {activeTab === "history" && visibleDateKeys.length > 0 && (
                  <div className="date-strip-wrap">
                    <p className="date-strip-label">Pick a day</p>
                    <div className="date-strip">
                      {visibleDateKeys.map((dk) => {
                        const dayItems = grouped[dk] ?? feedings.filter(
                          (f) => new Date(f.timestamp).toDateString() === dk,
                        );
                        const dayTotal = dayItems.reduce((s, f) => s + f.oz, 0);
                        return (
                          <button
                            key={dk}
                            type="button"
                            className={`date-pill ${selectedDateKey === dk ? "active" : ""}`}
                            onClick={() => setSelectedDateKey(dk)}
                          >
                            <span className="date-pill-label">{formatDatePill(dk)}</span>
                            <span className="date-pill-oz">{dayTotal.toFixed(1)}oz</span>
                            <span className="date-pill-count">{dayItems.length}x</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {!hasSelectedActivity ? (
                  <p className="empty-state">
                    {activeTab === "today"
                      ? "No feedings logged today yet."
                      : "No feedings on this day."}
                  </p>
                ) : (
                  <>
                    <div className="day-hero">
                      <div className="day-hero-left">
                        <span className="day-hero-date">
                          {formatDate(
                            selectedFeedings[0]?.timestamp ??
                              selectedAppetonTs ??
                              Date.now(),
                          )}
                        </span>
                        <span className="day-hero-count">
                          {selectedFeedings.length} feeding
                          {selectedFeedings.length !== 1 ? "s" : ""}
                        </span>
                      </div>
                      <div className="day-hero-oz">
                        <span className="day-hero-oz-num">{selectedTotal.toFixed(1)}</span>
                        <span className="day-hero-oz-unit">oz total</span>
                      </div>
                    </div>

                    {activeTab === "history" && (
                      <div className="day-milk-split">
                        <div className="day-milk-item">
                          <span className="day-milk-num">{selectedMilk.ebm.toFixed(1)}</span>
                          <span className="day-milk-unit">oz</span>
                          <span className="day-milk-label">EBM</span>
                        </div>
                        <div className="day-milk-item">
                          <span className="day-milk-num">{selectedMilk.fm.toFixed(1)}</span>
                          <span className="day-milk-unit">oz</span>
                          <span className="day-milk-label">FM</span>
                        </div>
                      </div>
                    )}

                    <ul className="feeding-list feed-list-v2">
                      {[...selectedActivity].reverse().map((item, i, arr) => {
                        if (item.kind === "appeton") {
                          return (
                            <li key="appeton" className="feeding-item">
                              <div className="activity-log-row">
                                <span className="activity-log-icon">💊</span>
                                <div className="activity-log-meta">
                                  <span className="activity-log-text">
                                  Idris has already taken Appeton!
                                  </span>
                                  <span className="feed-time">
                                    {formatTime(item.timestamp)}
                                  </span>
                                </div>
                                <button
                                  type="button"
                                  className="remove-btn"
                                  onClick={() => removeAppeton(selectedDateKey)}
                                  aria-label="Remove Appeton log"
                                >
                                  ×
                                </button>
                              </div>
                            </li>
                          );
                        }

                        const f = item.feeding;
                        const prevItem = arr[i + 1];
                        const prevTs =
                          prevItem?.kind === "feeding"
                            ? prevItem.feeding.timestamp
                            : prevItem?.kind === "appeton"
                              ? prevItem.timestamp
                              : null;
                        const gap = prevTs ? f.timestamp - prevTs : null;
                        const displayNote = feedingDisplayNote(f);
                        return (
                          <li key={f.id} className="feeding-item">
                            {gap && activeTab === "today" && (
                              <div className="feeding-gap">
                                {formatCountdown(gap).h > 0
                                  ? `${formatCountdown(gap).h}h ${formatCountdown(gap).m}m gap`
                                  : `${formatCountdown(gap).m}m gap`}
                              </div>
                            )}
                            <div className="feed-row">
                              <div className="feed-oz-block">
                                <span className="feed-oz-num">{f.oz}</span>
                                <span className="feed-oz-unit">oz</span>
                              </div>
                              <div className="feed-meta">
                                <span className="feed-time">{formatTime(f.timestamp)}</span>
                                {displayNote && (
                                  <span className="feed-note">{displayNote}</span>
                                )}
                              </div>
                              <button
                                type="button"
                                className="remove-btn"
                                onClick={() => removeFeeding(f.id)}
                                aria-label="Remove"
                              >
                                ×
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </>
            )}
          </div>
        </>
      )}

      <p className="sync-status">
        Synced with Supabase · updates live for both phones
      </p>
    </div>
  );
}
