/**
 * Site compliance utilities for regional regulatory requirements,
 * including China MIIT ICP filing guidelines (工信部 ICP 备案号悬挂规范).
 */

export const DEFAULT_ICP_NUMBER = "沪ICP备2026045701号";
export const MIIT_BEIAN_URL = "https://beian.miit.gov.cn/";

/**
 * Checks whether a given Xiaomi cloud / website region corresponds to Mainland China.
 */
export function isChinaMainlandRegion(region?: string | null): boolean {
  return (region || "cn").trim().toLowerCase() === "cn";
}

export type IcpFilingConfig = {
  enabled: boolean;
  icpNumber: string;
  url: string;
};

/**
 * Resolves the ICP filing configuration according to the region and environment.
 * For Mainland China pages, the filing number and link to https://beian.miit.gov.cn/
 * are enabled according to regulatory requirements.
 */
export function resolveIcpFiling(options?: {
  region?: string | null;
  customNumber?: string | null;
}): IcpFilingConfig {
  const region = options?.region ?? "cn";
  const isMainland = isChinaMainlandRegion(region);

  const rawNumber =
    options?.customNumber !== undefined
      ? options.customNumber
      : typeof process !== "undefined"
        ? process.env.NEXT_PUBLIC_ICP_NUMBER
        : undefined;

  const trimmed = rawNumber?.trim();
  if (trimmed === "none" || trimmed === "false") {
    return {
      enabled: false,
      icpNumber: "",
      url: MIIT_BEIAN_URL,
    };
  }

  return {
    enabled: isMainland,
    icpNumber: trimmed || DEFAULT_ICP_NUMBER,
    url: MIIT_BEIAN_URL,
  };
}
