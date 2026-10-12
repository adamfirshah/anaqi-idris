import { useState, useEffect, useCallback } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import {
  formatTime,
  formatDate,
  formatGrowthDate,
  formatWeightKg,
  formatDatePill,
  todayStr,
  todayIsoDate,
  formatCountdown,
  formatElapsed,
  toTimeInputValue,
  todayTimeInputToTimestamp,
  toDateInputValue,
  dateInputToTimestamp,
  formatBabyAge,
  BABY_BIRTH_DATE,
} from "../lib/format";
import type {
  FamilyInfo,
  Feeding,
  FeedingRow,
  MilkType,
  BabyMeasurement,
  BabyMeasurementRow,
  BabyAppointment,
  BabyAppointmentRow,
  PoopLog,
  PoopLogRow,
  DirectFeedLog,
  DirectFeedLogRow,
} from "../types/database";
import {
  rowToFeeding,
  feedingDisplayNote,
  rowToBabyMeasurement,
  rowToBabyAppointment,
  rowToPoopLog,
  poopDisplayText,
  rowToDirectFeedLog,
} from "../types/database";
import { usePushNotifications } from "../hooks/usePushNotifications";
import { showLocalNotification } from "../lib/push";
import { notifyFamilyOfActivity } from "../lib/activityNotifications";
import PumpTracker from "./PumpTracker";
import "../App.css";
import "../Auth.css";

const FEED_INTERVAL_MS = 2 * 60 * 60 * 1000;
const LOW_AMOUNT_FEED_INTERVAL_MS = 60 * 60 * 1000;
const PREPARE_WARN_MS = 60 * 60 * 1000;
const QUICK_OZ = ["2.0", "2.5", "3.0", "3.5", "4.0"] as const;
const MILK_TYPES = ["FM", "EBM"] as const;
const FORGOT_AGO_MIN = [15, 30, 45, 60] as const;
const APPOINTMENT_LOCATIONS = ["Dr. Kent Avisena", "KK Cyberjaya"] as const;

type Status = "none" | "ok" | "prepare" | "overdue";

function getFeedIntervalMs(
  oz: number,
  milkType: MilkType | "" | null,
): number {
  if (milkType === "EBM" && oz >= 3) return FEED_INTERVAL_MS;
  return milkType === "EBM" || (oz > 0 && oz <= 1)
    ? LOW_AMOUNT_FEED_INTERVAL_MS
    : FEED_INTERVAL_MS;
}

function getStatus(
  lastTs: number | null,
  intervalMs: number,
  now: number,
): Status {
  if (!lastTs) return "none";
  const remaining = intervalMs - (now - lastTs);
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

function upsertFeeding(items: Feeding[], feeding: Feeding): Feeding[] {
  return [...items.filter((item) => item.id !== feeding.id), feeding].sort(
    (a, b) => a.timestamp - b.timestamp,
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

function directFeedStorageKey(familyId: string) {
  return `direct-feeds-${familyId}`;
}

function readStoredDirectFeeds(familyId: string): DirectFeedLog[] {
  try {
    const raw = localStorage.getItem(directFeedStorageKey(familyId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as DirectFeedLog[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item) =>
        item &&
        typeof item.id === "string" &&
        typeof item.timestamp === "number",
    );
  } catch {
    return [];
  }
}

function writeStoredDirectFeeds(familyId: string, feeds: DirectFeedLog[]) {
  try {
    localStorage.setItem(directFeedStorageKey(familyId), JSON.stringify(feeds));
  } catch {
    /* ignore */
  }
}

function mergeDirectFeeds(
  familyId: string,
  ...sources: DirectFeedLog[][]
): DirectFeedLog[] {
  const merged = new Map<string, DirectFeedLog>();
  for (const source of sources) {
    for (const feed of source) {
      merged.set(feed.id, feed);
    }
  }
  const next = [...merged.values()].sort((a, b) => a.timestamp - b.timestamp);
  writeStoredDirectFeeds(familyId, next);
  return next;
}

function appointmentStorageKey(familyId: string) {
  return `baby-appointments-${familyId}`;
}

function readStoredAppointments(familyId: string): BabyAppointment[] {
  try {
    const raw = localStorage.getItem(appointmentStorageKey(familyId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as BabyAppointment[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item) =>
        item &&
        typeof item.id === "string" &&
        typeof item.appointmentAt === "number" &&
        typeof item.location === "string",
    );
  } catch {
    return [];
  }
}

function writeStoredAppointments(familyId: string, items: BabyAppointment[]) {
  try {
    localStorage.setItem(appointmentStorageKey(familyId), JSON.stringify(items));
  } catch {
    /* ignore */
  }
}

function mergeAppointments(
  familyId: string,
  ...sources: BabyAppointment[][]
): BabyAppointment[] {
  const merged = new Map<string, BabyAppointment>();
  for (const source of sources) {
    for (const item of source) {
      merged.set(item.id, item);
    }
  }
  const next = [...merged.values()].sort(
    (a, b) => a.appointmentAt - b.appointmentAt,
  );
  writeStoredAppointments(familyId, next);
  return next;
}

type ActivityItem =
  | { kind: "feeding"; feeding: Feeding }
  | { kind: "appeton"; timestamp: number }
  | { kind: "poop"; poop: PoopLog }
  | { kind: "direct_feed"; feed: DirectFeedLog };

function activityTimestamp(item: ActivityItem): number {
  if (item.kind === "feeding") return item.feeding.timestamp;
  if (item.kind === "poop") return item.poop.timestamp;
  if (item.kind === "direct_feed") return item.feed.timestamp;
  return item.timestamp;
}

function buildActivityList(
  feedings: Feeding[],
  appetonTs: number | null,
  poops: PoopLog[],
  directFeeds: DirectFeedLog[],
): ActivityItem[] {
  const items: ActivityItem[] = feedings.map((feeding) => ({
    kind: "feeding",
    feeding,
  }));
  if (appetonTs != null) {
    items.push({ kind: "appeton", timestamp: appetonTs });
  }
  for (const poop of poops) {
    items.push({ kind: "poop", poop });
  }
  for (const feed of directFeeds) {
    items.push({ kind: "direct_feed", feed });
  }
  return items.sort((a, b) => activityTimestamp(a) - activityTimestamp(b));
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
  const [growthHistory, setGrowthHistory] = useState<BabyMeasurement[]>([]);
  const [growthOpen, setGrowthOpen] = useState(false);
  const [growthAddOpen, setGrowthAddOpen] = useState(false);
  const [growthWeight, setGrowthWeight] = useState("");
  const [growthHeight, setGrowthHeight] = useState("");
  const [growthDate, setGrowthDate] = useState(() => toDateInputValue(Date.now()));
  const [growthSaving, setGrowthSaving] = useState(false);
  const latestMeasurement = growthHistory[0] ?? null;
  const [appointments, setAppointments] = useState<BabyAppointment[]>(() =>
    readStoredAppointments(family.familyId),
  );
  const [appointmentsOpen, setAppointmentsOpen] = useState(false);
  const [appointmentAddOpen, setAppointmentAddOpen] = useState(false);
  const [appointmentDate, setAppointmentDate] = useState(() =>
    toDateInputValue(Date.now()),
  );
  const [appointmentLocation, setAppointmentLocation] = useState("");
  const [appointmentNote, setAppointmentNote] = useState("");
  const [appointmentSaving, setAppointmentSaving] = useState(false);
  const [appetonLogs, setAppetonLogs] = useState<Record<string, number>>(
    () => readStoredAppetonLogs(family.familyId),
  );
  const [appetonSaving, setAppetonSaving] = useState(false);
  const appetonDoneToday = appetonLogs[todayStr()] != null;
  const [poopLogs, setPoopLogs] = useState<PoopLog[]>([]);
  const [justLoggedPoop, setJustLoggedPoop] = useState(false);
  const [directFeeds, setDirectFeeds] = useState<DirectFeedLog[]>(() =>
    readStoredDirectFeeds(family.familyId),
  );
  const [directFeedSaving, setDirectFeedSaving] = useState(false);
  const { notiStatus, notiError, iosHint, enableNotifications } = usePushNotifications(
    session.user.id,
  );

  const fetchGrowth = useCallback(async () => {
    const { data, error: fetchError } = await supabase
      .from("baby_measurements")
      .select("*")
      .order("measured_at", { ascending: false });

    if (fetchError) {
      if (!isMissingTableError(fetchError.message)) {
        setError(fetchError.message);
      }
      return;
    }

    setGrowthHistory(
      (data as BabyMeasurementRow[] | null)?.map(rowToBabyMeasurement) ?? [],
    );
  }, []);

  const openGrowthAdd = useCallback(() => {
    const latest = growthHistory[0];
    setGrowthWeight(latest?.weightKg != null ? String(latest.weightKg) : "");
    setGrowthHeight(latest?.heightCm != null ? String(latest.heightCm) : "");
    setGrowthDate(toDateInputValue(Date.now()));
    setGrowthAddOpen(true);
  }, [growthHistory]);

  const addGrowthMeasurement = useCallback(async () => {
    const w = parseFloat(growthWeight);
    const h = parseFloat(growthHeight);
    if (!w || w <= 0 || w > 30 || !h || h <= 0 || h > 200) return;

    setGrowthSaving(true);
    setError("");

    const { error: insertError } = await supabase.from("baby_measurements").insert({
      family_id: family.familyId,
      weight_kg: w,
      height_cm: h,
      measured_at: new Date(dateInputToTimestamp(growthDate)).toISOString(),
      logged_by: session.user.id,
    });

    setGrowthSaving(false);

    if (insertError) {
      if (!isMissingTableError(insertError.message)) {
        setError(insertError.message);
      }
      return;
    }

    setGrowthAddOpen(false);
    fetchGrowth();
  }, [
    growthWeight,
    growthHeight,
    growthDate,
    family.familyId,
    session.user.id,
    fetchGrowth,
  ]);

  const removeGrowthMeasurement = useCallback(
    async (id: string) => {
      const snapshot = growthHistory;
      setGrowthHistory((prev) => prev.filter((m) => m.id !== id));
      setError("");

      const { error: deleteError } = await supabase
        .from("baby_measurements")
        .delete()
        .eq("id", id);

      if (deleteError && !isMissingTableError(deleteError.message)) {
        setGrowthHistory(snapshot);
        setError(deleteError.message);
      }
    },
    [growthHistory],
  );

  const growthFormValid =
    parseFloat(growthWeight) > 0 &&
    parseFloat(growthWeight) <= 30 &&
    parseFloat(growthHeight) > 0 &&
    parseFloat(growthHeight) <= 200;

  const fetchAppointments = useCallback(async () => {
    const stored = readStoredAppointments(family.familyId);
    const { data, error: fetchError } = await supabase
      .from("baby_appointments")
      .select("*")
      .order("appointment_at", { ascending: true });

    if (fetchError) {
      if (!isMissingTableError(fetchError.message)) {
        setError(fetchError.message);
      }
      setAppointments(stored);
      return;
    }

    const fromDb =
      (data as BabyAppointmentRow[] | null)?.map(rowToBabyAppointment) ?? [];
    setAppointments(mergeAppointments(family.familyId, stored, fromDb));
  }, [family.familyId]);

  const openAppointmentAdd = useCallback(() => {
    setAppointmentDate(toDateInputValue(Date.now()));
    setAppointmentLocation("");
    setAppointmentNote("");
    setAppointmentAddOpen(true);
  }, []);

  const addAppointment = useCallback(async () => {
    const location = appointmentLocation.trim();
    if (!location) return;

    const tempId = crypto.randomUUID();
    const optimistic: BabyAppointment = {
      id: tempId,
      appointmentAt: dateInputToTimestamp(appointmentDate),
      location,
      note: appointmentNote.trim(),
    };

    setAppointmentSaving(true);
    setError("");
    setAppointments((prev) =>
      mergeAppointments(family.familyId, prev, [optimistic]),
    );

    const { data, error: insertError } = await supabase
      .from("baby_appointments")
      .insert({
        family_id: family.familyId,
        appointment_at: new Date(optimistic.appointmentAt).toISOString(),
        location,
        note: appointmentNote.trim() || null,
        logged_by: session.user.id,
      })
      .select()
      .single();

    setAppointmentSaving(false);

    if (insertError) {
      if (isMissingTableError(insertError.message)) {
        setAppointmentAddOpen(false);
        return;
      }
      setAppointments((prev) => {
        const next = prev.filter((a) => a.id !== tempId);
        writeStoredAppointments(family.familyId, next);
        return next;
      });
      setError(insertError.message);
      return;
    }

    const saved = rowToBabyAppointment(data as BabyAppointmentRow);
    setAppointments((prev) => {
      const withoutTemp = prev.filter((a) => a.id !== tempId);
      return mergeAppointments(family.familyId, withoutTemp, [saved]);
    });
    setAppointmentAddOpen(false);
  }, [
    appointmentDate,
    appointmentLocation,
    appointmentNote,
    family.familyId,
    session.user.id,
  ]);

  const removeAppointment = useCallback(
    async (id: string) => {
      const snapshot = appointments;
      setAppointments((prev) => {
        const next = prev.filter((a) => a.id !== id);
        writeStoredAppointments(family.familyId, next);
        return next;
      });
      setError("");

      const { error: deleteError } = await supabase
        .from("baby_appointments")
        .delete()
        .eq("id", id);

      if (deleteError && !isMissingTableError(deleteError.message)) {
        setAppointments(snapshot);
        writeStoredAppointments(family.familyId, snapshot);
        setError(deleteError.message);
      }
    },
    [appointments, family.familyId],
  );

  const appointmentFormValid = appointmentLocation.trim().length > 0;

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
    } else {
      void notifyFamilyOfActivity({
        type: "appeton",
        familyId: family.familyId,
      });
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
      .rpc("get_family_feedings", { p_family_id: family.familyId })
      .order("logged_at", { ascending: false })
      .limit(1000);

    if (fetchError) {
      setError(fetchError.message);
      return;
    }

    setFeedings(
      ((data as FeedingRow[] | null) ?? [])
        .map(rowToFeeding)
        .sort((a, b) => a.timestamp - b.timestamp),
    );
    setLoading(false);
  }, [family.familyId]);

  const fetchPoopLogs = useCallback(async () => {
    const { data, error: fetchError } = await supabase
      .from("poop_logs")
      .select("*")
      .order("logged_at", { ascending: true });

    if (fetchError) {
      if (!isMissingTableError(fetchError.message)) {
        setError(fetchError.message);
      }
      return;
    }

    setPoopLogs((data as PoopLogRow[] | null)?.map(rowToPoopLog) ?? []);
  }, []);

  const fetchDirectFeeds = useCallback(async () => {
    const stored = readStoredDirectFeeds(family.familyId);
    const { data, error: fetchError } = await supabase
      .from("direct_feed_logs")
      .select("*")
      .order("logged_at", { ascending: true });

    if (fetchError) {
      if (!isMissingTableError(fetchError.message)) {
        setError(fetchError.message);
      }
      setDirectFeeds(stored);
      return;
    }

    const fromDb =
      (data as DirectFeedLogRow[] | null)?.map(rowToDirectFeedLog) ?? [];
    setDirectFeeds(mergeDirectFeeds(family.familyId, stored, fromDb));
  }, [family.familyId]);

  useEffect(() => {
    fetchFeedings();
    fetchGrowth();
    fetchAppeton();
    fetchPoopLogs();
    fetchDirectFeeds();
    fetchAppointments();

    const feedingsChannel = supabase
      .channel("feedings-changes")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "feedings",
          filter: `family_id=eq.${family.familyId}`,
        },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const deletedId = (payload.old as Partial<FeedingRow>).id;
            if (deletedId) {
              setFeedings((previous) =>
                previous.filter((feeding) => feeding.id !== deletedId),
              );
            }
            return;
          }

          const row = payload.new as FeedingRow;
          if (row.family_id === family.familyId) {
            setFeedings((previous) =>
              upsertFeeding(previous, rowToFeeding(row)),
            );
          }
        },
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

    const appetonChannel = supabase
      .channel("daily-appeton-changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "daily_appeton" },
        () => fetchAppeton(),
      )
      .subscribe();

    const poopChannel = supabase
      .channel("poop-logs-changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "poop_logs" },
        () => fetchPoopLogs(),
      )
      .subscribe();

    const directFeedChannel = supabase
      .channel("direct-feed-logs-changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "direct_feed_logs" },
        () => fetchDirectFeeds(),
      )
      .subscribe();

    const appointmentsChannel = supabase
      .channel("baby-appointments-changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "baby_appointments" },
        () => fetchAppointments(),
      )
      .subscribe();

    return () => {
      supabase.removeChannel(feedingsChannel);
      supabase.removeChannel(growthChannel);
      supabase.removeChannel(appetonChannel);
      supabase.removeChannel(poopChannel);
      supabase.removeChannel(directFeedChannel);
      supabase.removeChannel(appointmentsChannel);
    };
  }, [
    fetchFeedings,
    fetchGrowth,
    fetchAppeton,
    fetchPoopLogs,
    fetchDirectFeeds,
    fetchAppointments,
    family.familyId,
  ]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const lastFeeding =
    feedings.length > 0 ? feedings[feedings.length - 1] : null;
  const lastDirectFeed =
    directFeeds.length > 0 ? directFeeds[directFeeds.length - 1] : null;
  const waitingForCue =
    lastDirectFeed != null &&
    (!lastFeeding || lastDirectFeed.timestamp > lastFeeding.timestamp);
  const feedIntervalMs = lastFeeding
    ? getFeedIntervalMs(lastFeeding.oz, lastFeeding.milkType)
    : FEED_INTERVAL_MS;
  const nextFeedTs =
    lastFeeding && !waitingForCue
      ? lastFeeding.timestamp + feedIntervalMs
      : null;
  const remaining = nextFeedTs ? nextFeedTs - now : null;
  const status = waitingForCue
    ? "cue"
    : getStatus(lastFeeding?.timestamp ?? null, feedIntervalMs, now);
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
  const todayDirectFeeds = directFeeds.filter(
    (f) => new Date(f.timestamp).toDateString() === todayStr(),
  );
  const todayPoopsCount = poopLogs.filter(
    (p) => new Date(p.timestamp).toDateString() === todayStr(),
  ).length;
  const todayActivityCount =
    todayFeedings.length +
    todayPoopsCount +
    todayDirectFeeds.length +
    (appetonLogs[todayStr()] != null ? 1 : 0);

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const nextAppointment =
    appointments
      .filter((a) => a.appointmentAt >= startOfToday.getTime())
      .sort((a, b) => a.appointmentAt - b.appointmentAt)[0] ?? null;
  const latestAppointment =
    [...appointments].sort(
      (a, b) => b.appointmentAt - a.appointmentAt,
    )[0] ?? null;

  const pastFeedings = feedings.filter(
    (f) => new Date(f.timestamp).toDateString() !== todayStr(),
  );
  const grouped = pastFeedings.reduce<Record<string, Feeding[]>>((acc, f) => {
    const k = new Date(f.timestamp).toDateString();
    (acc[k] ??= []).push(f);
    return acc;
  }, {});

  const allDateKeys = [
    ...new Set([
      ...feedings.map((f) => new Date(f.timestamp).toDateString()),
      ...poopLogs.map((p) => new Date(p.timestamp).toDateString()),
      ...directFeeds.map((f) => new Date(f.timestamp).toDateString()),
      ...Object.keys(appetonLogs),
    ]),
  ].sort((a, b) => new Date(b).getTime() - new Date(a).getTime());

  const pastDates = allDateKeys.filter((k) => k !== todayStr());

  const historyDateKeys =
    activeTab === "today" ? [todayStr()] : allDateKeys.filter((k) => k !== todayStr());

  const visibleDateKeys = activeTab === "today" ? [todayStr()] : historyDateKeys.length > 0 ? historyDateKeys : allDateKeys;

  const selectedFeedings = feedings.filter(
    (f) => new Date(f.timestamp).toDateString() === selectedDateKey,
  );
  const selectedPoops = poopLogs.filter(
    (p) => new Date(p.timestamp).toDateString() === selectedDateKey,
  );
  const selectedDirectFeeds = directFeeds.filter(
    (f) => new Date(f.timestamp).toDateString() === selectedDateKey,
  );
  const selectedTotal = selectedFeedings.reduce((s, f) => s + f.oz, 0);
  const selectedMilk = dayMilkTotals(selectedFeedings);
  const selectedAppetonTs = appetonLogs[selectedDateKey] ?? null;
  const selectedActivity = buildActivityList(
    selectedFeedings,
    selectedAppetonTs,
    selectedPoops,
    selectedDirectFeeds,
  );
  const hasSelectedActivity = selectedActivity.length > 0;

  const logFeeding = useCallback(
    async (loggedAtTs: number) => {
      const parsed = parseFloat(oz);
      if (!parsed || parsed <= 0 || parsed > 10) return;

      setError("");
      const { data: insertedRow, error: insertError } = await supabase
        .from("feedings")
        .insert({
          family_id: family.familyId,
          logged_at: new Date(loggedAtTs).toISOString(),
          oz: parsed,
          milk_type: milkType || null,
          note: note.trim() || null,
          logged_by: session.user.id,
        })
        .select("*")
        .single();

      if (insertError || !insertedRow) {
        setError(insertError?.message ?? "Supabase did not confirm the saved feed.");
        return;
      }

      const savedFeeding = rowToFeeding(insertedRow as FeedingRow);
      setFeedings((previous) => upsertFeeding(previous, savedFeeding));
      setNote("");
      setForgotOpen(false);
      setJustLogged(true);
      setTimeout(() => setJustLogged(false), 2000);

      const noteParts = [milkType, note.trim()].filter(Boolean).join(" · ");
      await showLocalNotification(
        "🍼 Feed logged",
        `Logged at ${formatTime(loggedAtTs)} · ${parsed}oz${noteParts ? ` · ${noteParts}` : ""}`,
        "anaqi-feed-logged",
      );
      void notifyFamilyOfActivity({
        type: "milk",
        familyId: family.familyId,
        oz: parsed,
        milkType: milkType || null,
      });
    },
    [oz, milkType, note, family.familyId, session.user.id],
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

  const logPoop = useCallback(
    async (loggedAtTs: number) => {
      setError("");
      const { error: insertError } = await supabase.from("poop_logs").insert({
        family_id: family.familyId,
        logged_at: new Date(loggedAtTs).toISOString(),
        poop_type: "Poo",
        logged_by: session.user.id,
      });

      if (insertError) {
        if (!isMissingTableError(insertError.message)) {
          setError(insertError.message);
        }
        return;
      }

      setJustLoggedPoop(true);
      setTimeout(() => setJustLoggedPoop(false), 2000);
      fetchPoopLogs();

      await showLocalNotification(
        "💩 Poop logged",
        `${poopDisplayText("Poo")} at ${formatTime(loggedAtTs)}`,
        "anaqi-poop-logged",
      );
      void notifyFamilyOfActivity({
        type: "poop",
        familyId: family.familyId,
      });
    },
    [family.familyId, session.user.id, fetchPoopLogs],
  );

  const removePoop = useCallback(
    async (id: string) => {
      const { error: deleteError } = await supabase
        .from("poop_logs")
        .delete()
        .eq("id", id);
      if (deleteError && !isMissingTableError(deleteError.message)) {
        setError(deleteError.message);
      } else {
        fetchPoopLogs();
      }
    },
    [fetchPoopLogs],
  );

  const logDirectFeed = useCallback(async () => {
    const loggedAt = Date.now();
    const tempId = crypto.randomUUID();
    const optimistic: DirectFeedLog = { id: tempId, timestamp: loggedAt };

    setDirectFeedSaving(true);
    setError("");
    setActiveTab("today");
    setSelectedDateKey(todayStr());
    setDirectFeeds((prev) => mergeDirectFeeds(family.familyId, prev, [optimistic]));

    const { data, error: insertError } = await supabase
      .from("direct_feed_logs")
      .insert({
        family_id: family.familyId,
        logged_at: new Date(loggedAt).toISOString(),
        logged_by: session.user.id,
      })
      .select()
      .single();

    setDirectFeedSaving(false);

    if (insertError) {
      if (isMissingTableError(insertError.message)) {
        return;
      }
      setDirectFeeds((prev) => {
        const next = prev.filter((feed) => feed.id !== tempId);
        writeStoredDirectFeeds(family.familyId, next);
        return next;
      });
      setError(insertError.message);
      return;
    }

    const saved = rowToDirectFeedLog(data as DirectFeedLogRow);
    setDirectFeeds((prev) => {
      const withoutTemp = prev.filter((feed) => feed.id !== tempId);
      return mergeDirectFeeds(family.familyId, withoutTemp, [saved]);
    });
    void notifyFamilyOfActivity({
      type: "direct_feed",
      familyId: family.familyId,
    });
  }, [family.familyId, session.user.id]);

  const removeDirectFeed = useCallback(
    async (id: string) => {
      const snapshot = directFeeds;
      setDirectFeeds((prev) => {
        const next = prev.filter((feed) => feed.id !== id);
        writeStoredDirectFeeds(family.familyId, next);
        return next;
      });
      setError("");

      const { error: deleteError } = await supabase
        .from("direct_feed_logs")
        .delete()
        .eq("id", id);

      if (deleteError && !isMissingTableError(deleteError.message)) {
        setDirectFeeds(snapshot);
        writeStoredDirectFeeds(family.familyId, snapshot);
        setError(deleteError.message);
      }
    },
    [directFeeds, family.familyId],
  );

  const forgotTs = todayTimeInputToTimestamp(forgotTime);
  const forgotValid = forgotTs <= Date.now();

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
              {person === "anaqi" && (
                <span className="header-age">
                  {" · "}
                  {formatBabyAge(BABY_BIRTH_DATE, now)}
                </span>
              )}
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
        <PumpTracker
          session={session}
          family={family}
          directFeeds={directFeeds}
          lastDirectFeed={lastDirectFeed}
          waitingForCue={waitingForCue}
          lastBottleFeedTs={lastFeeding?.timestamp ?? null}
          feedIntervalMs={feedIntervalMs}
          onRemoveDirectFeed={removeDirectFeed}
        />
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
              <span className="growth-collapse-title">GROWTH </span>
              {latestMeasurement ? (
                <>
                  <span className="growth-collapse-metrics">
                    {formatWeightKg(latestMeasurement.weightKg)} kg ·{" "}
                    {latestMeasurement.heightCm ?? "—"} cm
                  </span>
                  <span className="growth-collapse-date">
                    {formatGrowthDate(latestMeasurement.measuredAt)}
                  </span>
                </>
              ) : (
                <span className="growth-collapse-summary">No data yet</span>
              )}
              <span className="growth-collapse-chevron" aria-hidden>
                {growthOpen ? "▾" : "▸"}
              </span>
            </button>
            {growthOpen && (
              <div className="growth-collapse-body">
                {latestMeasurement ? (
                  <>
                    {/* <div className="growth-latest-banner">
                      <p className="growth-latest-label">Latest</p>
                      <p className="growth-latest-date">
                        {formatGrowthDate(latestMeasurement.measuredAt)}
                      </p>
                    </div> */}
                    <div className="growth-collapse-stats">
                      <div className="stat-box">
                        <span className="stat-value">
                          {formatWeightKg(latestMeasurement.weightKg)}
                        </span>
                        <span className="stat-unit">kg</span>
                        <p className="stat-label">Weight</p>
                      </div>
                      <div className="stat-box">
                        <span className="stat-value">
                          {latestMeasurement.heightCm ?? "—"}
                        </span>
                        <span className="stat-unit">cm</span>
                        <p className="stat-label">Height</p>
                      </div>
                    </div>
                  </>
                ) : (
                  <p className="empty-state">No growth data yet.</p>
                )}

                {growthHistory.length > 0 && (
                  <div className="growth-history">
                    <p className="growth-history-label">History</p>
                    <ul className="growth-history-list">
                      {growthHistory.map((m, i) => (
                        <li
                          key={m.id}
                          className={`growth-history-item ${i === 0 ? "latest" : ""}`}
                        >
                          <span className="growth-history-values">
                            {formatWeightKg(m.weightKg)} kg · {m.heightCm ?? "—"} cm
                          </span>
                          <span className="growth-history-date">
                            {formatGrowthDate(m.measuredAt)}
                          </span>
                          {i === 0 && (
                            <span className="growth-history-badge">Latest</span>
                          )}
                          <button
                            type="button"
                            className="remove-btn"
                            onClick={() => removeGrowthMeasurement(m.id)}
                            aria-label="Remove measurement"
                          >
                            ×
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {growthAddOpen ? (
                  <div className="growth-add-form">
                    <p className="section-label">Weight (kg)</p>
                    <div className="custom-row">
                      <input
                        type="number"
                        className="oz-input"
                        value={growthWeight}
                        onChange={(e) => setGrowthWeight(e.target.value)}
                        min="0.1"
                        max="30"
                        step="0.01"
                        inputMode="decimal"
                        placeholder="5.02"
                        aria-label="Weight in kg"
                      />
                      <span className="oz-unit">kg</span>
                    </div>
                    <p className="section-label">Height (cm)</p>
                    <div className="custom-row">
                      <input
                        type="number"
                        className="oz-input"
                        value={growthHeight}
                        onChange={(e) => setGrowthHeight(e.target.value)}
                        min="1"
                        max="200"
                        step="0.1"
                        inputMode="decimal"
                        placeholder="60"
                        aria-label="Height in cm"
                      />
                      <span className="oz-unit">cm</span>
                    </div>
                    <p className="section-label">Measured on</p>
                    <input
                      type="date"
                      className="growth-date-input"
                      value={growthDate}
                      onChange={(e) => setGrowthDate(e.target.value)}
                      aria-label="Measurement date"
                    />
                    <div className="growth-add-actions">
                      <button
                        type="button"
                        className="growth-add-cancel"
                        onClick={() => setGrowthAddOpen(false)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="growth-add-save"
                        disabled={!growthFormValid || growthSaving}
                        onClick={addGrowthMeasurement}
                      >
                        {growthSaving ? "Saving…" : "Save"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="growth-add-btn"
                    onClick={openGrowthAdd}
                  >
                    + Add weight & height
                  </button>
                )}
              </div>
            )}
          </div>

          <div className={`growth-collapse ${appointmentsOpen ? "open" : ""}`}>
            <button
              type="button"
              className="growth-collapse-toggle"
              onClick={() => setAppointmentsOpen((open) => !open)}
              aria-expanded={appointmentsOpen}
            >
              <span className="growth-collapse-title">Appointment</span>
              {nextAppointment ? (
                <>
                  <span className="growth-collapse-metrics">
                    {formatGrowthDate(nextAppointment.appointmentAt)} ·{" "}
                    {nextAppointment.location}
                  </span>
                </>
              ) : latestAppointment ? (
                <span className="growth-collapse-metrics">
                  Latest: {formatGrowthDate(latestAppointment.appointmentAt)} ·{" "}
                  {latestAppointment.location}
                </span>
              ) : (
                <span className="growth-collapse-summary">No appointments</span>
              )}
              <span className="growth-collapse-chevron" aria-hidden>
                {appointmentsOpen ? "▾" : "▸"}
              </span>
            </button>
            {appointmentsOpen && (
              <div className="growth-collapse-body">
                {nextAppointment && (
                  <div className="growth-latest-banner">
                    <p className="growth-latest-label">Next</p>
                    <p className="growth-latest-date">
                      {formatGrowthDate(nextAppointment.appointmentAt)} ·{" "}
                      {nextAppointment.location}
                    </p>
                    {nextAppointment.note && (
                      <p className="appointment-note">{nextAppointment.note}</p>
                    )}
                  </div>
                )}

                {appointments.length > 0 ? (
                  <div className="growth-history">
                    <p className="growth-history-label">All appointments</p>
                    <ul className="growth-history-list">
                      {appointments.map((a) => (
                        <li key={a.id} className="growth-history-item">
                          <div className="appointment-item-content">
                            <span className="growth-history-values">
                              {formatGrowthDate(a.appointmentAt)}
                            </span>
                            <span className="appointment-location">{a.location}</span>
                            {a.note && (
                              <span className="appointment-note">{a.note}</span>
                            )}
                          </div>
                          <button
                            type="button"
                            className="remove-btn"
                            onClick={() => removeAppointment(a.id)}
                            aria-label="Remove appointment"
                          >
                            ×
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="empty-state">No appointments yet.</p>
                )}

                {appointmentAddOpen ? (
                  <div className="growth-add-form">
                    <p className="section-label">When</p>
                    <input
                      type="date"
                      className="growth-date-input"
                      value={appointmentDate}
                      onChange={(e) => setAppointmentDate(e.target.value)}
                      aria-label="Appointment date"
                    />
                    <p className="section-label">Where</p>
                    <div className="milk-type-row">
                      {APPOINTMENT_LOCATIONS.map((loc) => (
                        <button
                          key={loc}
                          type="button"
                          className={`milk-btn ${appointmentLocation === loc ? "active" : ""}`}
                          onClick={() =>
                            setAppointmentLocation((prev) =>
                              prev === loc ? "" : loc,
                            )
                          }
                        >
                          {loc}
                        </button>
                      ))}
                    </div>
                    <input
                      type="text"
                      className="note-input"
                      value={appointmentLocation}
                      onChange={(e) => setAppointmentLocation(e.target.value)}
                      placeholder="or type another place"
                      maxLength={120}
                    />
                    <p className="section-label">Remark</p>
                    <input
                      type="text"
                      className="note-input"
                      value={appointmentNote}
                      onChange={(e) => setAppointmentNote(e.target.value)}
                      placeholder="optional"
                      maxLength={120}
                    />
                    <div className="growth-add-actions">
                      <button
                        type="button"
                        className="growth-add-cancel"
                        onClick={() => setAppointmentAddOpen(false)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="growth-add-save"
                        disabled={!appointmentFormValid || appointmentSaving}
                        onClick={addAppointment}
                      >
                        {appointmentSaving ? "Saving…" : "Save"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="growth-add-btn"
                    onClick={openAppointmentAdd}
                  >
                    + Add appointment
                  </button>
                )}
              </div>
            )}
          </div>

          <div className={`card countdown-card status-${status}`}>
            {waitingForCue && lastDirectFeed && (
              <>
                <p className="cd-label">🤱 Idris just had Direct feed</p>
                <p className="cd-time cd-time-cue">Watch for cue</p>
                {lastFeeding && (
                  <p className="cd-sub">
                    Supposed next bottle feed{" "}
                    {formatTime(lastFeeding.timestamp + feedIntervalMs)}
                  </p>
                )}
              </>
            )}

            {!waitingForCue && status === "none" && (
              <>
                <p className="cd-label">No feedings yet</p>
                <p className="cd-time">—</p>
                <p className="cd-sub">Log the first feeding below</p>
              </>
            )}

            {!waitingForCue &&
              status === "ok" &&
              lastFeeding &&
              nextFeedTs &&
              (() => {
                const prepareTs =
                  lastFeeding.timestamp + feedIntervalMs - PREPARE_WARN_MS;
                const cd = formatCountdown(prepareTs - now);
                return (
                  <>
                    <p className="cd-label">Prep susu</p>
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

            {!waitingForCue && status === "prepare" && countdown && nextFeedTs && (
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

            {!waitingForCue && status === "overdue" && countdown && lastFeeding && (
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

          {status === "prepare" && !waitingForCue && (
            <div className="prepare-banner">
              <span className="prepare-icon">⏱️</span>
              <span>
                Prep time - and ready to feed him{" "}
              </span>
            </div>
          )}

          <div className="stats-row stats-row-secondary">
            <div className="stat-box stat-box-highlight">
              <span className="stat-value">
                {lastFeeding ? formatTime(lastFeeding.timestamp) : "—"}
              </span>
              <p className="stat-label">
                {waitingForCue ? "Last bottle fed" : "Last fed"}
              </p>
            </div>
            <div className="stat-box stat-box-highlight">
              <span className="stat-value">
                {waitingForCue
                  ? lastFeeding
                    ? formatTime(lastFeeding.timestamp + feedIntervalMs)
                    : "—"
                  : nextFeedTs
                    ? formatTime(nextFeedTs)
                    : "—"}
              </span>
              <p className="stat-label">
                {waitingForCue ? "Est next bottle feed" : "Next feed"}
              </p>
            </div>
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
            <div className="stat-box">
              <span className="stat-value">{todayDirectFeeds.length}</span>
              <p className="stat-label">Direct feed</p>
            </div>
          </div>

          <div className="quick-log-row">
            <button
              type="button"
              className="direct-feed-btn"
              disabled={directFeedSaving}
              onClick={logDirectFeed}
            >
              {directFeedSaving ? "Saving…" : "👶 Direct feed"}
            </button>

            <button
              type="button"
              className={`poop-btn ${justLoggedPoop ? "logged" : ""}`}
              onClick={() => logPoop(Date.now())}
            >
              {justLoggedPoop ? "✓ Poop" : "💩 Poop"}
            </button>

            <button
              type="button"
              className="appeton-btn"
              disabled={appetonDoneToday || appetonSaving}
              onClick={markAppetonDone}
            >
              {appetonSaving
                ? "Saving…"
                : appetonDoneToday
                  ? "✓ Appeton"
                  : "💊 Appeton"}
            </button>
          </div>

          <div className="card log-card">
            <h2 className="card-title">How much Idris drink?</h2>

            <p className="section-label">Amount</p>
            <div className="oz-row">
              {QUICK_OZ.map((q) => (
                <button
                  key={q}
                  type="button"
                  className={`oz-btn ${oz === q ? "active" : ""}`}
                  onClick={() => setOz(q)}
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
              disabled={forgotOpen}
              onClick={() => logFeeding(Date.now())}
            >
              {justLogged ? "✓ Logged!" : "🍼 Log Feed Now"}
            </button>

            {error && <p className="auth-error">{error}</p>}

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
                {!forgotValid && (
                  <p className="forgot-error">
                    Pick a time that is not in the future
                  </p>
                )}
                <div className="time-preview">
                  <span className="time-preview-label">So jadinya</span>
                    <span className="time-preview-val">
                      {oz}oz at {formatTime(forgotTs)}
                    </span>
                    <span className="time-preview-next">
                      → next feed ~
                      {formatTime(
                        forgotTs +
                          getFeedIntervalMs(parseFloat(oz) || 0, milkType),
                      )}
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
              {todayActivityCount > 0 && (
                <span className="tab-badge">{todayActivityCount}</span>
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
              <p className="empty-state">No past activity recorded.</p>
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
                      ? "No activity logged today yet."
                      : "No activity on this day."}
                  </p>
                ) : (
                  <>
                    <div className="day-hero">
                      <div className="day-hero-left">
                        <span className="day-hero-date">
                          {formatDate(
                            selectedFeedings[0]?.timestamp ??
                              selectedAppetonTs ??
                              selectedPoops[0]?.timestamp ??
                              selectedDirectFeeds[0]?.timestamp ??
                              Date.now(),
                          )}
                        </span>
                        <span className="day-hero-count">
                          {[
                            selectedFeedings.length > 0 &&
                              `${selectedFeedings.length} feeding${selectedFeedings.length !== 1 ? "s" : ""}`,
                            selectedPoops.length > 0 &&
                              `${selectedPoops.length} poop${selectedPoops.length !== 1 ? "s" : ""}`,
                            selectedDirectFeeds.length > 0 &&
                              `${selectedDirectFeeds.length} direct feed${selectedDirectFeeds.length !== 1 ? "s" : ""}`,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </div>
                      <div className="day-hero-oz">
                        <span className="day-hero-oz-num">{selectedTotal.toFixed(1)}</span>
                        <span className="day-hero-oz-unit">oz total</span>
                      </div>
                    </div>

                    {activeTab === "history" && (
                      <div className="day-milk-split day-milk-split-three">
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
                        <div className="day-milk-item">
                          <span className="day-milk-num">
                            {selectedDirectFeeds.length}
                          </span>
                          <span className="day-milk-unit">
                            {selectedDirectFeeds.length > 0 ? "x" : "no direct"}
                          </span>
                          <span className="day-milk-label">Direct feed</span>
                        </div>
                      </div>
                    )}

                    <ul
                      className={`feeding-list feed-list-v2 ${
                        selectedActivity.length > 10 ? "feed-list-scroll" : ""
                      }`}
                    >
                      {[...selectedActivity].reverse().map((item, i, arr) => {
                        const prevItem = arr[i + 1];
                        const prevTs = prevItem ? activityTimestamp(prevItem) : null;
                        const ts = activityTimestamp(item);
                        const gap = prevTs ? ts - prevTs : null;
                        const gapEl =
                          gap && activeTab === "today" ? (
                            <div className="feeding-gap">
                              {formatCountdown(gap).h > 0
                                ? `${formatCountdown(gap).h}h ${formatCountdown(gap).m}m gap`
                                : `${formatCountdown(gap).m}m gap`}
                            </div>
                          ) : null;

                        if (item.kind === "appeton") {
                          return (
                            <li key="appeton" className="feeding-item">
                              {gapEl}
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

                        if (item.kind === "poop") {
                          const p = item.poop;
                          return (
                            <li key={p.id} className="feeding-item">
                              {gapEl}
                              <div className="activity-log-row activity-poop-row">
                                <span className="activity-log-icon">💩</span>
                                <div className="activity-log-meta">
                                  <span className="activity-log-text">
                                    {poopDisplayText(p.poopType)}
                                  </span>
                                  <span className="feed-time">
                                    {formatTime(p.timestamp)}
                                  </span>
                                </div>
                                <button
                                  type="button"
                                  className="remove-btn"
                                  onClick={() => removePoop(p.id)}
                                  aria-label="Remove poop log"
                                >
                                  ×
                                </button>
                              </div>
                            </li>
                          );
                        }

                        if (item.kind === "direct_feed") {
                          const df = item.feed;
                          return (
                            <li key={df.id} className="feeding-item">
                              {gapEl}
                              <div className="activity-log-row activity-direct-feed-row">
                                <span className="activity-log-icon">👶</span>
                                <div className="activity-log-meta">
                                  <span className="activity-log-text">
                                    Direct feed with Idris!
                                  </span>
                                  <span className="feed-time">
                                    {formatTime(df.timestamp)}
                                  </span>
                                </div>
                                <button
                                  type="button"
                                  className="remove-btn"
                                  onClick={() => removeDirectFeed(df.id)}
                                  aria-label="Remove direct feed log"
                                >
                                  ×
                                </button>
                              </div>
                            </li>
                          );
                        }

                        const f = item.feeding;
                        const displayNote = feedingDisplayNote(f);
                        return (
                          <li key={f.id} className="feeding-item">
                            {gapEl}
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
    </div>
  );
}
