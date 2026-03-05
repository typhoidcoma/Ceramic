import type { LogogramMorphologyProfile, LogogramStyle } from "../../data/types";
import { hashStringU32 } from "../../data/types";

function clamp01(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

const families: LogogramMorphologyProfile[] = [
  {
    id: "dense_ring_heavy_blobs",
    ringWeight: 0.88,
    blobDominance: 0.84,
    tendrilMode: "drip_sparse_whisker",
    gapCountBias: 0.58,
    gapSpanBias: 0.46,
    style: {
      ring_circle_count_bias: 0.9,
      ring_circle_thickness_bias: 0.78,
      ring_center_variation_bias: 0.4,
      ring_disk_count_bias: 0.72,
      ring_disk_radius_bias: 0.66,
      blob_arc_extent_bias: 0.62,
      blob_disk_count_bias: 0.84,
      blob_disk_radius_bias: 0.82,
      tendril_primary_count_bias: 0.42,
      tendril_primary_length_bias: 0.72,
      tendril_whisker_count_bias: 0.28,
      tendril_noise_exp_bias: 0.5,
      gap_count_bias: 0.58,
      gap_span_bias: 0.44,
    },
  },
  {
    id: "thin_ring_sparse_blobs",
    ringWeight: 0.72,
    blobDominance: 0.52,
    tendrilMode: "drip_sparse_whisker",
    gapCountBias: 0.66,
    gapSpanBias: 0.56,
    style: {
      ring_circle_count_bias: 0.78,
      ring_circle_thickness_bias: 0.42,
      ring_center_variation_bias: 0.52,
      ring_disk_count_bias: 0.42,
      ring_disk_radius_bias: 0.4,
      blob_arc_extent_bias: 0.42,
      blob_disk_count_bias: 0.48,
      blob_disk_radius_bias: 0.5,
      tendril_primary_count_bias: 0.34,
      tendril_primary_length_bias: 0.62,
      tendril_whisker_count_bias: 0.24,
      tendril_noise_exp_bias: 0.56,
      gap_count_bias: 0.66,
      gap_span_bias: 0.56,
    },
  },
  {
    id: "asymmetric_blobs",
    ringWeight: 0.8,
    blobDominance: 0.76,
    tendrilMode: "drip_sparse_whisker",
    gapCountBias: 0.5,
    gapSpanBias: 0.38,
    style: {
      ring_circle_count_bias: 0.82,
      ring_circle_thickness_bias: 0.62,
      ring_center_variation_bias: 0.44,
      ring_disk_count_bias: 0.58,
      ring_disk_radius_bias: 0.6,
      blob_arc_extent_bias: 0.68,
      blob_disk_count_bias: 0.76,
      blob_disk_radius_bias: 0.74,
      tendril_primary_count_bias: 0.46,
      tendril_primary_length_bias: 0.68,
      tendril_whisker_count_bias: 0.3,
      tendril_noise_exp_bias: 0.52,
      gap_count_bias: 0.5,
      gap_span_bias: 0.38,
    },
  },
];

const conceptFamily = new Map<string, string>([
  ["concept:human", "dense_ring_heavy_blobs"],
  ["concept:time", "asymmetric_blobs"],
  ["concept:weapon", "thin_ring_sparse_blobs"],
  ["concept:earth", "asymmetric_blobs"],
  ["concept:heptapod", "dense_ring_heavy_blobs"],
  ["concept:language", "asymmetric_blobs"],
  ["concept:memory", "thin_ring_sparse_blobs"],
  ["concept:future", "asymmetric_blobs"],
  ["concept:life", "dense_ring_heavy_blobs"],
]);

function familyById(id: string): LogogramMorphologyProfile {
  return families.find((f) => f.id === id) ?? families[0];
}

export function resolveMorphologyProfile(canonicalKey: string, messageHash: string): LogogramMorphologyProfile {
  const mapped = conceptFamily.get(canonicalKey);
  if (mapped) return familyById(mapped);
  const seed = hashStringU32(`${canonicalKey}|${messageHash}`);
  return families[seed % families.length];
}

export function mergeStyleWithProfile(style: LogogramStyle, profile: LogogramMorphologyProfile): LogogramStyle {
  return {
    ...profile.style,
    ...style,
    gap_count_bias: clamp01(typeof style.gap_count_bias === "number" ? style.gap_count_bias : profile.gapCountBias),
    gap_span_bias: clamp01(typeof style.gap_span_bias === "number" ? style.gap_span_bias : profile.gapSpanBias),
  };
}

