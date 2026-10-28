#pragma once

#include <stddef.h>
#include <stdint.h>

inline bool hasFrameContent(const uint8_t* rgba, size_t pixels) {
  for (size_t pixel = 0; pixel < pixels; ++pixel) {
    const auto* color = rgba + pixel * 4;
    if (color[0] > 8 || color[1] > 8 || color[2] > 8) return true;
  }
  return false;
}
