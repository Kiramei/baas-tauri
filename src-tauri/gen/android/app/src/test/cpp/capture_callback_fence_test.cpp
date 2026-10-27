#include "../../main/cpp/capture_callback_fence.h"
#include <assert.h>
#include <atomic>
#include <chrono>
#include <future>
#include <thread>
#include <utility>

int main() {
  CaptureCallbackFence fence;
  assert(!fence.tryAcquire());
  fence.waitUntilIdle();

  fence.open();
  auto first = fence.tryAcquire();
  auto second = fence.tryAcquire();
  assert(first && second);
  auto moved = std::move(first);
  assert(!first && moved);
  fence.close();
  assert(!fence.tryAcquire());

  std::promise<void> entered;
  std::promise<void> drained;
  auto done = drained.get_future();
  std::thread stopper([&] {
    entered.set_value();
    fence.waitUntilIdle();
    drained.set_value();
  });
  entered.get_future().wait();
  assert(done.wait_for(std::chrono::milliseconds(20)) == std::future_status::timeout);
  second = {};
  assert(done.wait_for(std::chrono::milliseconds(20)) == std::future_status::timeout);
  moved = {};
  assert(done.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
  stopper.join();

  // A fresh session can admit callbacks again after old-session cleanup.
  for (int session = 0; session < 100; ++session) {
    fence.open();
    std::atomic<int> admitted{0};
    std::promise<void> release;
    auto ready = release.get_future().share();
    std::thread producer([&] {
      auto lease = fence.tryAcquire();
      assert(lease);
      ++admitted;
      ready.wait();
    });
    while (admitted.load() == 0) std::this_thread::yield();
    fence.close();
    assert(!fence.tryAcquire());
    release.set_value();
    fence.waitUntilIdle();
    producer.join();
  }
  return 0;
}
