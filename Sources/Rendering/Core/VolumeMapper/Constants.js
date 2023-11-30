export const BlendMode = {
  COMPOSITE_BLEND: 0,
  MAXIMUM_INTENSITY_BLEND: 1,
  MINIMUM_INTENSITY_BLEND: 2,
  AVERAGE_INTENSITY_BLEND: 3,
  ADDITIVE_INTENSITY_BLEND: 4,
  RADON_TRANSFORM_BLEND: 5,
  // custom blend mode를 엄청나게 큰 수를 줘서 겹칠 일 없게
  INTERPOLATED_BLEND: 1000,
  GRADIENT_OPACITY_BLEND: 1001,
  CPR_THICKNESS_BLEND: 1002,
};

export const FilterMode = {
  OFF: 0,
  NORMALIZED: 1,
  RAW: 2,
};

export default {
  BlendMode,
  FilterMode,
};
