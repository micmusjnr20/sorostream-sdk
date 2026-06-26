import type { Attributes, Span, SpanOptions, Tracer } from "@opentelemetry/api";

let _otelModule: typeof import("@opentelemetry/api") | null = null;

function getOtel(): typeof import("@opentelemetry/api") | null {
  if (_otelModule !== undefined) return _otelModule;
  try {
    _otelModule = require("@opentelemetry/api");
  } catch {
    _otelModule = null;
  }
  return _otelModule;
}

export class Telemetry {
  private tracer: Tracer | null = null;
  readonly enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled;
    if (enabled) {
      const otel = getOtel();
      if (otel) {
        this.tracer = otel.trace.getTracer("@sorostream/sdk", "0.1.0");
      }
    }
  }

  startSpan(name: string, options?: SpanOptions): Span | null {
    if (!this.tracer) return null;
    return this.tracer.startSpan(name, options);
  }

  endSpan(span: Span | null, attributes?: Attributes): void {
    if (!span) return;
    if (attributes) span.setAttributes(attributes);
    span.end();
  }

  setAttributes(span: Span | null, attributes: Attributes): void {
    if (!span) return;
    span.setAttributes(attributes);
  }

  recordError(span: Span | null, error: Error): void {
    if (!span) return;
    span.recordException(error);
    span.setAttribute("error", true);
  }
}
