import { useState, useEffect, useCallback } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import {
  formatTime,
  formatDate,
  formatDatePill,
  todayStr,
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
} from "../types/database";
import { rowToFeeding, feedingDisplayNote } from "../types/database";
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

type Status = "none" | "ok" | "prepare" | "overdue";

function getStatus(lastTs: number | null, now: number): Status {
  if (!lastTs) return "none";
  const remaining = FEED_INTERVAL_MS - (now - lastTs);
  if (remaining < 0) return "overdue";
  if (remaining <= PREPARE_WARN_MS) return "prepare";
  return "ok";
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
  const { notiStatus, notiError, iosHint, enableNotifications } = usePushNotifications(
    session.user.id,
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

    const channel = supabase
      .channel("feedings-changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "feedings" },
        () => fetchFeedings(),
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchFeedings]);

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
          👶 Anaqi
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

            <input
              type="text"
              className="note-input"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="remark"
              maxLength={80}
            />

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
            )}

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

            {selectedFeedings.length === 0 ? (
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
                      {formatDate(selectedFeedings[0].timestamp)}
                    </span>
                    <span className="day-hero-count">
                      {selectedFeedings.length} feeding{selectedFeedings.length !== 1 ? "s" : ""}
                    </span>
                  </div>
                  <div className="day-hero-oz">
                    <span className="day-hero-oz-num">{selectedTotal.toFixed(1)}</span>
                    <span className="day-hero-oz-unit">oz total</span>
                  </div>
                </div>

                <ul className="feeding-list feed-list-v2">
                  {[...selectedFeedings].reverse().map((f, i, arr) => {
                    const prev = arr[i + 1];
                    const gap = prev ? f.timestamp - prev.timestamp : null;
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
