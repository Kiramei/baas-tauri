#include "../../main/cpp/frame_content.h"
#include <assert.h>

int main() {
  uint8_t rgba[64] = {};
  assert(!hasFrameContent(rgba, 0));
  for (size_t i = 0; i < 16; ++i) rgba[i * 4 + 3] = 255;
  assert(!hasFrameContent(rgba, 16));
  for (size_t channel = 0; channel < 3; ++channel) {
    rgba[60 + channel] = 8;
    assert(!hasFrameContent(rgba, 16));
    rgba[60 + channel] = 9;
    assert(hasFrameContent(rgba, 16));
    rgba[60 + channel] = 0;
  }
  rgba[0] = 255;
  assert(hasFrameContent(rgba, 16));
  return 0;
}
