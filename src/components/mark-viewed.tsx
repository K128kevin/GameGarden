"use client";

import { useEffect } from "react";
import { markPlanViewed } from "@/app/actions";

/** Marks a plan's latest update as seen (clears the "Updated" badge). */
export function MarkViewed({ planId, needed }: { planId: string; needed: boolean }) {
  useEffect(() => {
    if (!needed) return;
    const t = setTimeout(() => void markPlanViewed(planId), 1500);
    return () => clearTimeout(t);
  }, [planId, needed]);
  return null;
}
