#pragma once

#include <condition_variable>
#include <cstddef>
#include <mutex>
#include <utility>

// Publication uses the capture mutex, but slow buffer reads must not hold it.
// Closing admission before waiting keeps the reader alive for every admitted
// callback, including one which is still copying when capture is stopped.
class CaptureCallbackFence {
 public:
  class Lease {
   public:
    Lease() = default;
    Lease(const Lease&) = delete;
    Lease& operator=(const Lease&) = delete;
    Lease(Lease&& other) noexcept : owner_(std::exchange(other.owner_, nullptr)) {}
    Lease& operator=(Lease&& other) noexcept {
      if (this != &other) {
        release();
        owner_ = std::exchange(other.owner_, nullptr);
      }
      return *this;
    }
    ~Lease() { release(); }
    explicit operator bool() const { return owner_ != nullptr; }

   private:
    friend class CaptureCallbackFence;
    explicit Lease(CaptureCallbackFence* owner) : owner_(owner) {}
    void release() {
      if (!owner_) return;
      std::lock_guard<std::mutex> lock(owner_->mutex_);
      if (--owner_->active_ == 0) owner_->idle_.notify_all();
      owner_ = nullptr;
    }
    CaptureCallbackFence* owner_ = nullptr;
  };

  // The caller serializes session open/close and only reopens after draining.
  void open() {
    std::lock_guard<std::mutex> lock(mutex_);
    accepting_ = true;
  }
  Lease tryAcquire() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!accepting_) return {};
    ++active_;
    return Lease(this);
  }
  void close() {
    std::lock_guard<std::mutex> lock(mutex_);
    accepting_ = false;
  }
  void waitUntilIdle() {
    std::unique_lock<std::mutex> lock(mutex_);
    idle_.wait(lock, [this] { return active_ == 0; });
  }

 private:
  std::mutex mutex_;
  std::condition_variable idle_;
  std::size_t active_ = 0;
  bool accepting_ = false;
};
