/**
 * Main-process-only C2-5B product-journey seam.
 *
 * The product journey runner owns the environment names and values.  This
 * module mirrors that small declaration so the Electron main bundle does not
 * import the runner (which would pull the harness into the application).
 * Renderer, preload, and IPC never see this configuration.
 */

export const NARRATIVE_MAINTENANCE_FAULT_ENV =
  "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_FAULT";
export const NARRATIVE_MAINTENANCE_TRIGGER_ENV =
  "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_TRIGGER";
export const NARRATIVE_MAINTENANCE_SETUP_ENV =
  "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_SETUP";
export const NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV =
  "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_OWNER_TOKEN";
export const NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_BARRIER_ENV =
  "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_BARRIER_ID";
export const NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CORRELATION_ENV =
  "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_CORRELATION";
export const NARRATIVE_MAINTENANCE_OWNER_TOKEN =
  "c2-5b-product-journey-owner-v1";

export const NARRATIVE_MAINTENANCE_FAULTS = Object.freeze([
  "transient-io",
  "contract-violation",
  "process-interruption",
] as const);
export const NARRATIVE_MAINTENANCE_TRIGGERS = Object.freeze([
  "dependency-gap",
  "foreground-workspace-wake",
  "graphContractDigest-changed",
  "ruleRegistryDigest-changed",
  "producerGenerationSetDigest-changed",
] as const);

export type NarrativeMaintenanceCiFault =
  (typeof NARRATIVE_MAINTENANCE_FAULTS)[number];
export type NarrativeMaintenanceCiTrigger =
  (typeof NARRATIVE_MAINTENANCE_TRIGGERS)[number];

export interface NarrativeMaintenanceCiConfig {
  readonly ownerToken: string;
  readonly fault: NarrativeMaintenanceCiFault | null;
  readonly trigger: NarrativeMaintenanceCiTrigger | null;
  readonly setup: "disabled" | null;
  readonly productJourneyBarrierId: string | null;
  readonly correlation: string | null;
}

export type NarrativeMaintenanceCiSeam =
  | { readonly active: false }
  | ({ readonly active: true } & NarrativeMaintenanceCiConfig);

/**
 * The setup marker belongs to one product-journey configure launch only. It
 * is intentionally evaluated in main, after the owner/CI gate, so an
 * ordinary launch cannot inherit the marker or disable its scheduler.
 */
export function shouldDisableNarrativeMaintenanceForLaunch(
  seam: NarrativeMaintenanceCiSeam,
): boolean {
  return seam.active && seam.setup === "disabled";
}

export interface NarrativeMaintenanceCiEnvironment {
  readonly isPackaged: boolean;
  readonly env: NodeJS.ProcessEnv;
}

export interface NarrativeMaintenanceCiBackend {
  configureNarrativeMaintenanceCiSeam?(
    payload: NarrativeMaintenanceCiNativePayload,
  ): Promise<unknown> | unknown;
}

/** Wire shape kept private to the main/N-API boundary. */
export interface NarrativeMaintenanceCiNativePayload {
  readonly isPackaged: boolean;
  readonly ci: string | undefined;
  readonly ownerToken: string;
  readonly fault: NarrativeMaintenanceCiFault | null;
  readonly trigger: NarrativeMaintenanceCiTrigger | null;
  readonly setup: "disabled" | null;
  readonly productJourneyBarrierId: string | null;
  readonly correlation: string | null;
}

const hasValue = (value: string | undefined): value is string =>
  value !== undefined && value.trim().length > 0;

function enumValue<T extends readonly string[]>(
  env: NodeJS.ProcessEnv,
  name: string,
  values: T,
): T[number] | null {
  const raw = env[name];
  if (!hasValue(raw)) return null;
  if (!values.includes(raw as T[number])) {
    throw new Error(`${name} has unsupported value '${raw}'`);
  }
  return raw as T[number];
}

function optionalIdentifier(
  env: NodeJS.ProcessEnv,
  name: string,
): string | null {
  const raw = env[name];
  if (!hasValue(raw)) return null;
  if (raw !== raw.trim()) {
    throw new Error(`${name} must be trimmed`);
  }
  if (raw.includes("\u0000")) {
    throw new Error(`${name} must not contain NUL`);
  }
  return raw;
}

/**
 * Parse the runner seam only after the outer activation gate is satisfied.
 * Every test-only variable is ignored—including malformed values—when the
 * launch is packaged, non-CI, or owned by another caller.
 */
export function parseNarrativeMaintenanceCiSeam(
  env: NodeJS.ProcessEnv = process.env,
  { isPackaged }: Pick<NarrativeMaintenanceCiEnvironment, "isPackaged"> = {
    isPackaged: false,
  },
): NarrativeMaintenanceCiSeam {
  const ownerToken = env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
  if (
    isPackaged ||
    env.CI !== "true" ||
    ownerToken !== NARRATIVE_MAINTENANCE_OWNER_TOKEN
  ) {
    return { active: false };
  }

  const fault = enumValue(
    env,
    NARRATIVE_MAINTENANCE_FAULT_ENV,
    NARRATIVE_MAINTENANCE_FAULTS,
  );
  const trigger = enumValue(
    env,
    NARRATIVE_MAINTENANCE_TRIGGER_ENV,
    NARRATIVE_MAINTENANCE_TRIGGERS,
  );
  const setupRaw = env[NARRATIVE_MAINTENANCE_SETUP_ENV];
  if (hasValue(setupRaw) && setupRaw !== "disabled") {
    throw new Error(
      `${NARRATIVE_MAINTENANCE_SETUP_ENV} has unsupported value '${setupRaw}'`,
    );
  }
  const productJourneyBarrierId = optionalIdentifier(
    env,
    NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_BARRIER_ENV,
  );
  const correlation = optionalIdentifier(
    env,
    NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CORRELATION_ENV,
  );
  if ((productJourneyBarrierId === null) !== (correlation === null)) {
    throw new Error(
      `${NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_BARRIER_ENV} and ` +
        `${NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CORRELATION_ENV} must be supplied together`,
    );
  }

  return {
    active: true,
    ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN,
    fault,
    trigger,
    setup: setupRaw === "disabled" ? "disabled" : null,
    productJourneyBarrierId,
    correlation,
  };
}

function parseNativeStatus(raw: unknown): void {
  if (typeof raw === "string") {
    try {
      return parseNativeStatus(JSON.parse(raw) as unknown);
    } catch {
      throw new Error("native C2-5B seam returned malformed JSON");
    }
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw) ||
    (raw as Record<string, unknown>).status !== "enabled"
  ) {
    throw new Error("native C2-5B seam did not acknowledge enablement");
  }
}

/**
 * Validate and configure exactly once during main startup. The caller invokes
 * this immediately after `initBackend()` and before creating any scheduler.
 */
export async function configureNarrativeMaintenanceCiSeam(
  backend: NarrativeMaintenanceCiBackend | null,
  environment: NarrativeMaintenanceCiEnvironment,
): Promise<NarrativeMaintenanceCiSeam> {
  const seam = parseNarrativeMaintenanceCiSeam(environment.env, {
    isPackaged: environment.isPackaged,
  });
  if (!seam.active) return seam;
  const configure = backend?.configureNarrativeMaintenanceCiSeam;
  if (typeof configure !== "function") {
    throw new Error(
      "active C2-5B product journey requires native seam configuration",
    );
  }
  const result = await configure.call(backend, {
    isPackaged: environment.isPackaged,
    ci: environment.env.CI,
    ownerToken: seam.ownerToken,
    fault: seam.fault,
    trigger: seam.trigger,
    setup: seam.setup,
    productJourneyBarrierId: seam.productJourneyBarrierId,
    correlation: seam.correlation,
  });
  parseNativeStatus(result);
  return seam;
}
