import { NextRequest, NextResponse } from "next/server";
import {
  GeminiMissingKeyError,
  GeminiUpstreamError,
  parseVoiceCommandWithGemini,
} from "@/lib/server/intentParser";
import { appendAuditLog, listPublicDevices } from "@/lib/server/store";
import {
  broadcastAuditEntry,
  dispatchCommandToAgent,
} from "@/lib/server/wsHub";
import { validateCommandPlan } from "@/lib/ultron/router";
import { detectThemeCommand } from "@/lib/ultron/themes";
import type {
  AgentCommandResult,
  ParsedCommandIntent,
} from "@/lib/ultron/types";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      text?: string;
      source?: "voice" | "text";
      currentDeviceId?: string | null;
      confirmed?: boolean;
    };

    const rawText = (body.text ?? "").trim();
    const source = body.source === "voice" ? "voice" : "text";
    if (!rawText) {
      return NextResponse.json(
        { error: "Command text cannot be empty." },
        { status: 400 },
      );
    }

    const devices = listPublicDevices();
    const localThemeMatch = detectThemeCommand(rawText);
    const parsedIntent: ParsedCommandIntent = localThemeMatch
      ? {
          intent: "SET_THEME",
          targetDevice: null,
          application: null,
          theme: localThemeMatch.theme,
          requiresConfirmation: false,
          spokenSummary: localThemeMatch.spokenResponse,
        }
      : await parseVoiceCommandWithGemini(rawText, devices);

    const plan = validateCommandPlan(parsedIntent, devices, {
      currentDeviceId: body.currentDeviceId,
      confirmed: Boolean(body.confirmed),
    });

    if (
      plan.status === "immediate_response" ||
      plan.status === "clarification_needed" ||
      plan.status === "error"
    ) {
      const entry = appendAuditLog({
        source,
        rawCommand: rawText,
        intent: parsedIntent.intent,
        targetDeviceId: null,
        targetDeviceName:
          parsedIntent.intent === "SET_THEME"
            ? parsedIntent.theme ?? null
            : parsedIntent.targetDevice,
        status: plan.status === "error" ? "rejected" : "succeeded",
        detail: plan.spokenResponse,
      });
      broadcastAuditEntry(entry);

      return NextResponse.json({
        status: plan.status,
        parsedIntent,
        theme: parsedIntent.theme ?? null,
        spokenResponse: plan.spokenResponse,
        rejectedDevices: plan.rejectedDevices,
        results: [],
      });
    }

    if (plan.status === "confirmation_required") {
      const entry = appendAuditLog({
        source,
        rawCommand: rawText,
        intent: parsedIntent.intent,
        targetDeviceId: plan.pendingConfirmation?.targetDeviceIds[0] ?? null,
        targetDeviceName:
          plan.dispatches.map((d) => d.device.name).join(", ") || null,
        status: "pending_confirmation",
        detail: plan.spokenResponse,
      });
      broadcastAuditEntry(entry);

      return NextResponse.json({
        status: "confirmation_required",
        parsedIntent,
        spokenResponse: plan.spokenResponse,
        pendingConfirmation: plan.pendingConfirmation,
        rejectedDevices: plan.rejectedDevices,
        results: [],
      });
    }

    // Execute across all validated target devices
    const executionResults: Array<{
      deviceId: string;
      deviceName: string;
      deviceType: string;
      result: AgentCommandResult;
    }> = [];

    for (const item of plan.dispatches) {
      const res = await dispatchCommandToAgent({
        deviceId: item.device.id,
        action: item.action,
        application: item.application,
        requestedBy: source,
      });
      executionResults.push({
        deviceId: item.device.id,
        deviceName: item.device.name,
        deviceType: item.device.type,
        result: res,
      });

      const entry = appendAuditLog({
        source,
        rawCommand: rawText,
        intent: parsedIntent.intent,
        targetDeviceId: item.device.id,
        targetDeviceName: item.device.name,
        status: res.success ? "succeeded" : "failed",
        detail: res.message,
      });
      broadcastAuditEntry(entry);
    }

    const successes = executionResults.filter((r) => r.result.success);
    const failures = executionResults.filter((r) => !r.result.success);

    const parts: string[] = [];
    for (const ok of successes) {
      parts.push(ok.result.message);
    }
    for (const fail of failures) {
      parts.push(`${fail.deviceName}: ${fail.result.message}`);
    }
    for (const rej of plan.rejectedDevices) {
      parts.push(rej.reason);
    }

    return NextResponse.json({
      status: failures.length === 0 && plan.rejectedDevices.length === 0 ? "succeeded" : "partial_or_failed",
      parsedIntent,
      spokenResponse: parts.join(" ") || plan.spokenResponse,
      rejectedDevices: plan.rejectedDevices,
      results: executionResults,
    });
  } catch (err: unknown) {
    if (err instanceof GeminiMissingKeyError) {
      return NextResponse.json(
        { error: err.message, errorCode: "MISSING_GEMINI_KEY" },
        { status: 503 },
      );
    }
    if (err instanceof GeminiUpstreamError) {
      return NextResponse.json(
        { error: err.message, errorCode: "GEMINI_API_ERROR" },
        { status: err.status },
      );
    }
    console.error("[ULTRON Command POST]", err);
    return NextResponse.json(
      { error: "Failed to process ULTRON command." },
      { status: 500 },
    );
  }
}
