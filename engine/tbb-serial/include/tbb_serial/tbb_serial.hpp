// Serial stand-in for the subset of oneTBB used by OrcaSlicer's libslic3r and deps_src.
// Used only by the single-threaded WASM build (no SharedArrayBuffer => no threads).
//
// Contract: every construct runs on the calling thread, in order. That is a valid TBB execution
// (TBB never promises concurrency), so correct TBB code behaves the same; it only loses speed.
// Containers keep TBB's guarantees that matter serially (concurrent_vector never moves
// elements, so it is backed by std::deque).
//
// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once

#include <algorithm>
#include <chrono>
#include <cstddef>
#include <cstdlib>
#include <deque>
#include <exception>
#include <functional>
#include <iterator>
#include <map>
#include <set>
#include <memory>
#include <optional>
#include <type_traits>
#include <unordered_map>
#include <unordered_set>
#include <utility>

// Report a oneTBB 2021-compatible API so libslic3r takes its modern code paths.
#define TBB_VERSION_MAJOR 2021
#define TBB_VERSION_MINOR 13
#define TBB_INTERFACE_VERSION 12130
#define TBB_INTERFACE_VERSION_MAJOR 12
#define DOLPHIN_SLICER_TBB_SERIAL 1

namespace tbb {

// ── ranges & partitioners ─────────────────────────────────────────────────────
struct split {};

template<typename Value>
class blocked_range {
public:
    using value_type     = Value;
    using const_iterator = Value;
    using size_type      = std::size_t;

    blocked_range() = default;
    blocked_range(Value begin, Value end, size_type grainsize = 1)
        : m_begin(begin), m_end(end), m_grainsize(grainsize) {}

    const_iterator begin() const { return m_begin; }
    const_iterator end() const { return m_end; }
    size_type size() const { return size_type(m_end - m_begin); }
    size_type grainsize() const { return m_grainsize; }
    bool empty() const { return !(m_begin < m_end); }
    bool is_divisible() const { return m_grainsize < size(); }

private:
    Value     m_begin{};
    Value     m_end{};
    size_type m_grainsize = 1;
};
template<typename V> blocked_range(V, V) -> blocked_range<V>;
template<typename V, typename G> blocked_range(V, V, G) -> blocked_range<V>;

struct simple_partitioner {};
struct auto_partitioner {};
struct static_partitioner {};
class affinity_partitioner {};

namespace detail {
template<typename T, typename = void> struct is_range : std::false_type {};
template<typename T>
struct is_range<T, std::void_t<decltype(std::declval<const T &>().is_divisible())>> : std::true_type {};
} // namespace detail

// ── parallel_for ──────────────────────────────────────────────────────────────
template<typename Range, typename Body, std::enable_if_t<detail::is_range<Range>::value, int> = 0>
void parallel_for(const Range &range, const Body &body) { body(range); }
template<typename Range, typename Body, typename Partitioner,
         std::enable_if_t<detail::is_range<Range>::value, int> = 0>
void parallel_for(const Range &range, const Body &body, Partitioner &&) { body(range); }

template<typename Index, typename Function, std::enable_if_t<!detail::is_range<Index>::value, int> = 0>
void parallel_for(Index first, Index last, const Function &f) {
    for (Index i = first; i < last; ++i) f(i);
}
template<typename Index, typename Function, typename Partitioner,
         std::enable_if_t<!detail::is_range<Index>::value && !std::is_convertible<Partitioner, Index>::value, int> = 0>
void parallel_for(Index first, Index last, const Function &f, Partitioner &&) {
    for (Index i = first; i < last; ++i) f(i);
}
template<typename Index, typename Function, std::enable_if_t<!detail::is_range<Index>::value, int> = 0>
void parallel_for(Index first, Index last, Index step, const Function &f) {
    for (Index i = first; i < last; i += step) f(i);
}

// ── parallel_reduce / parallel_deterministic_reduce ──────────────────────────
template<typename Range, typename Value, typename RealBody, typename Reduction>
Value parallel_reduce(const Range &range, const Value &identity, const RealBody &body, const Reduction &) {
    return body(range, identity);
}
template<typename Range, typename Value, typename RealBody, typename Reduction, typename Partitioner>
Value parallel_reduce(const Range &range, const Value &identity, const RealBody &body, const Reduction &, Partitioner &&) {
    return body(range, identity);
}
template<typename Range, typename Body>
void parallel_reduce(const Range &range, Body &body) { body(range); }
template<typename Range, typename Body, typename Partitioner>
void parallel_reduce(const Range &range, Body &body, Partitioner &&) { body(range); }

template<typename Range, typename Value, typename RealBody, typename Reduction>
Value parallel_deterministic_reduce(const Range &range, const Value &identity, const RealBody &body, const Reduction &) {
    return body(range, identity);
}

// ── parallel_sort / parallel_for_each / parallel_invoke ──────────────────────
template<typename It> void parallel_sort(It begin, It end) { std::sort(begin, end); }
template<typename It, typename Cmp> void parallel_sort(It begin, It end, const Cmp &cmp) { std::sort(begin, end, cmp); }
template<typename Container, typename = decltype(std::begin(std::declval<Container &>()))>
void parallel_sort(Container &c) { std::sort(std::begin(c), std::end(c)); }
template<typename Container, typename Cmp, typename = decltype(std::begin(std::declval<Container &>()))>
void parallel_sort(Container &c, const Cmp &cmp) { std::sort(std::begin(c), std::end(c), cmp); }

template<typename It, typename F> void parallel_for_each(It first, It last, const F &f) {
    for (; first != last; ++first) f(*first);
}
template<typename Container, typename F> void parallel_for_each(Container &c, const F &f) {
    for (auto &v : c) f(v);
}
template<typename... F> void parallel_invoke(F &&...fs) { (std::forward<F>(fs)(), ...); }

// ── parallel_pipeline ─────────────────────────────────────────────────────────
enum class filter_mode { parallel = 0x0100, serial_in_order = 0x0101, serial_out_of_order = 0x0001 };

class flow_control {
public:
    void stop() { m_stopped = true; }
    bool is_stopped() const { return m_stopped; }
private:
    bool m_stopped = false;
};

namespace detail {
struct unit {};
template<typename T> using wrap_t = std::conditional_t<std::is_void<T>::value, unit, T>;
} // namespace detail

template<typename In, typename Out>
class filter {
public:
    using in_t  = detail::wrap_t<In>;
    using out_t = detail::wrap_t<Out>;
    using fn_t  = std::function<std::optional<out_t>(in_t &&, flow_control &)>;

    filter() = default;
    explicit filter(fn_t fn) : m_fn(std::move(fn)) {}

    template<typename Body>
    filter(filter_mode, const Body &body) : m_fn(make(body)) {}

    std::optional<out_t> operator()(in_t &&in, flow_control &fc) const { return m_fn(std::move(in), fc); }

private:
    template<typename Body> static fn_t make(const Body &body) {
        return [body](in_t &&in, flow_control &fc) -> std::optional<out_t> {
            if constexpr (std::is_void<In>::value) {
                (void) in;
                if constexpr (std::is_void<Out>::value) { body(fc); return fc.is_stopped() ? std::nullopt : std::optional<out_t>(out_t{}); }
                else { out_t v = body(fc); if (fc.is_stopped()) return std::nullopt; return std::optional<out_t>(std::move(v)); }
            } else {
                if constexpr (std::is_void<Out>::value) { body(std::move(in)); return out_t{}; }
                else return std::optional<out_t>(body(std::move(in)));
            }
        };
    }
    fn_t m_fn;
};

template<typename In, typename Out, typename Body>
filter<In, Out> make_filter(filter_mode mode, const Body &body) { return filter<In, Out>(mode, body); }

template<typename A, typename B, typename C>
filter<A, C> operator&(const filter<A, B> &l, const filter<B, C> &r) {
    return filter<A, C>([l, r](typename filter<A, C>::in_t &&in, flow_control &fc)
                            -> std::optional<typename filter<A, C>::out_t> {
        auto mid = l(std::move(in), fc);
        if (!mid) return std::nullopt;
        return r(std::move(*mid), fc);
    });
}

inline void parallel_pipeline(std::size_t /*max_tokens*/, const filter<void, void> &chain) {
    flow_control fc;
    for (;;) {
        detail::unit u;
        if (!chain(std::move(u), fc)) break;
        if (fc.is_stopped()) break;
    }
}

// ── task_group ────────────────────────────────────────────────────────────────
enum task_group_status { not_complete, complete, canceled };

class task_group;
namespace detail { inline task_group *&current_group() { static task_group *g = nullptr; return g; } }

class task_group {
public:
    task_group() = default;
    task_group(const task_group &) = delete;
    ~task_group() = default;

    template<typename F> void run(F &&f) {
        if (m_canceled) return;
        task_group *prev = detail::current_group();
        detail::current_group() = this;
        try { std::forward<F>(f)(); } catch (...) {
            if (!m_exception) m_exception = std::current_exception();
            m_canceled = true;
        }
        detail::current_group() = prev;
    }
    template<typename F> task_group_status run_and_wait(F &&f) { run(std::forward<F>(f)); return wait(); }
    task_group_status wait() {
        if (m_exception) { auto e = m_exception; m_exception = nullptr; std::rethrow_exception(e); }
        return m_canceled ? canceled : complete;
    }
    void cancel() { m_canceled = true; }
    bool is_canceling() const { return m_canceled; }

private:
    bool               m_canceled = false;
    std::exception_ptr m_exception;
};

inline bool is_current_task_group_canceling() {
    task_group *g = detail::current_group();
    return g && g->is_canceling();
}

// ── arenas / global control ──────────────────────────────────────────────────
class task_arena {
public:
    static constexpr int automatic = -1;
    task_arena(int = automatic, unsigned = 1) {}
    void initialize() {}
    template<typename F> auto execute(F &&f) -> decltype(f()) { return std::forward<F>(f)(); }
    int max_concurrency() const { return 1; }
};
namespace this_task_arena {
inline int max_concurrency() { return 1; }
inline int current_thread_index() { return 0; }
template<typename F> auto isolate(F &&f) -> decltype(f()) { return std::forward<F>(f)(); }
} // namespace this_task_arena

class global_control {
public:
    enum parameter { max_allowed_parallelism, thread_stack_size, terminate_on_exception, scheduler_handle };
    global_control(parameter, std::size_t) {}
    static std::size_t active_value(parameter p) { return p == max_allowed_parallelism ? 1 : 0; }
};

// ── mutexes ───────────────────────────────────────────────────────────────────
template<typename Tag>
class null_mutex_t {
public:
    class scoped_lock {
    public:
        scoped_lock() = default;
        explicit scoped_lock(null_mutex_t &) {}
        void acquire(null_mutex_t &) {}
        bool try_acquire(null_mutex_t &) { return true; }
        void release() {}
    };
    void lock() {}
    bool try_lock() { return true; }
    void unlock() {}
};
using spin_mutex     = null_mutex_t<struct spin_tag>;
using mutex          = null_mutex_t<struct mutex_tag>;
using queuing_mutex  = null_mutex_t<struct queuing_tag>;
using speculative_spin_mutex = null_mutex_t<struct spec_tag>;

// ── containers ───────────────────────────────────────────────────────────────
template<typename T, typename Alloc = std::allocator<T>>
class concurrent_vector : public std::deque<T, Alloc> {
    using base = std::deque<T, Alloc>;
public:
    using base::base;
    using typename base::iterator;
    iterator push_back(const T &v) { base::push_back(v); return std::prev(base::end()); }
    iterator push_back(T &&v) { base::push_back(std::move(v)); return std::prev(base::end()); }
    template<typename... A> iterator emplace_back(A &&...a) {
        base::emplace_back(std::forward<A>(a)...); return std::prev(base::end());
    }
    iterator grow_by(std::size_t n) {
        std::size_t old = base::size(); base::resize(old + n); return base::begin() + old;
    }
    iterator grow_by(std::size_t n, const T &v) {
        std::size_t old = base::size(); base::resize(old + n, v); return base::begin() + old;
    }
    iterator grow_to_at_least(std::size_t n) {
        if (base::size() < n) base::resize(n);
        return base::begin() + n;
    }
};

template<typename K, typename V, typename H = std::hash<K>, typename E = std::equal_to<K>,
         typename A = std::allocator<std::pair<const K, V>>>
class concurrent_unordered_map : public std::unordered_map<K, V, H, E, A> {
    using base = std::unordered_map<K, V, H, E, A>;
public:
    using base::base;
    template<typename Key> auto unsafe_erase(const Key &k) { return base::erase(k); }
};
template<typename K, typename H = std::hash<K>, typename E = std::equal_to<K>, typename A = std::allocator<K>>
class concurrent_unordered_set : public std::unordered_set<K, H, E, A> {
    using base = std::unordered_set<K, H, E, A>;
public:
    using base::base;
    template<typename Key> auto unsafe_erase(const Key &k) { return base::erase(k); }
};


// ── multi-dimensional ranges ─────────────────────────────────────────────────
template<typename RowValue, typename ColValue = RowValue>
class blocked_range2d {
public:
    using row_range_type = blocked_range<RowValue>;
    using col_range_type = blocked_range<ColValue>;
    blocked_range2d(RowValue rb, RowValue re, ColValue cb, ColValue ce) : m_rows(rb, re), m_cols(cb, ce) {}
    blocked_range2d(RowValue rb, RowValue re, std::size_t rg, ColValue cb, ColValue ce, std::size_t cg)
        : m_rows(rb, re, rg), m_cols(cb, ce, cg) {}
    const row_range_type &rows() const { return m_rows; }
    const col_range_type &cols() const { return m_cols; }
    bool empty() const { return m_rows.empty() || m_cols.empty(); }
    bool is_divisible() const { return m_rows.is_divisible() || m_cols.is_divisible(); }
private:
    row_range_type m_rows;
    col_range_type m_cols;
};
template<typename PageValue, typename RowValue = PageValue, typename ColValue = RowValue>
class blocked_range3d {
public:
    blocked_range3d(PageValue pb, PageValue pe, RowValue rb, RowValue re, ColValue cb, ColValue ce)
        : m_pages(pb, pe), m_rows(rb, re), m_cols(cb, ce) {}
    const blocked_range<PageValue> &pages() const { return m_pages; }
    const blocked_range<RowValue> &rows() const { return m_rows; }
    const blocked_range<ColValue> &cols() const { return m_cols; }
    bool empty() const { return m_pages.empty() || m_rows.empty() || m_cols.empty(); }
    bool is_divisible() const { return m_pages.is_divisible() || m_rows.is_divisible() || m_cols.is_divisible(); }
private:
    blocked_range<PageValue> m_pages;
    blocked_range<RowValue>  m_rows;
    blocked_range<ColValue>  m_cols;
};

// ── more containers / utilities used by CGAL headers ─────────────────────────
template<typename K, typename V, typename HashCompare = void, typename A = void>
class concurrent_hash_map {
    using map_t = std::unordered_map<K, V>;
public:
    using value_type = typename map_t::value_type;
    using iterator = typename map_t::iterator;
    using const_iterator = typename map_t::const_iterator;
    class const_accessor {
    public:
        const value_type &operator*() const { return *m_it; }
        const value_type *operator->() const { return &*m_it; }
        bool empty() const { return !m_valid; }
        void release() { m_valid = false; }
    protected:
        friend class concurrent_hash_map;
        typename map_t::iterator m_it{};
        bool m_valid = false;
    };
    class accessor : public const_accessor {
    public:
        value_type &operator*() const { return *this->m_it; }
        value_type *operator->() const { return &*this->m_it; }
    };
    bool insert(const_accessor &a, const K &k) { auto r = m_map.try_emplace(k); a.m_it = r.first; a.m_valid = true; return r.second; }
    bool insert(const value_type &v) { return m_map.insert(v).second; }
    bool find(const_accessor &a, const K &k) const {
        auto it = const_cast<map_t &>(m_map).find(k);
        a.m_valid = it != m_map.end(); if (a.m_valid) a.m_it = it; return a.m_valid;
    }
    bool erase(const K &k) { return m_map.erase(k) > 0; }
    std::size_t size() const { return m_map.size(); }
    bool empty() const { return m_map.empty(); }
    void clear() { m_map.clear(); }
    iterator begin() { return m_map.begin(); }
    iterator end() { return m_map.end(); }
    const_iterator begin() const { return m_map.begin(); }
    const_iterator end() const { return m_map.end(); }
private:
    map_t m_map;
};

enum ets_key_usage_type { ets_key_per_instance, ets_no_key };
template<typename T, typename A = std::allocator<T>, ets_key_usage_type = ets_no_key>
class enumerable_thread_specific {
public:
    enumerable_thread_specific() = default;
    explicit enumerable_thread_specific(const T &exemplar) : m_value(exemplar) {}
    template<typename F, typename = decltype(std::declval<F>()())>
    explicit enumerable_thread_specific(F f) : m_value(f()) {}
    using value_type     = T;
    using iterator       = T *;
    using const_iterator = const T *;
    using reference      = T &;
    T &local() { m_used = true; return m_value; }
    T &local(bool &exists) { exists = m_used; m_used = true; return m_value; }
    std::size_t size() const { return m_used ? 1 : 0; }
    bool empty() const { return !m_used; }
    T *begin() { return m_used ? &m_value : &m_value + 1; }
    T *end() { return &m_value + 1; }
    const T *begin() const { return m_used ? &m_value : &m_value + 1; }
    const T *end() const { return &m_value + 1; }
    template<typename F> T combine(F f) const { (void)f; return m_value; }
    template<typename F> void combine_each(F f) const { if (m_used) f(m_value); }
    void clear() { m_used = false; m_value = T(); }
private:
    T    m_value{};
    bool m_used = false;
};
template<typename T> using combinable = enumerable_thread_specific<T>;

template<typename K, typename V, typename C = std::less<K>, typename A = std::allocator<std::pair<const K, V>>>
class concurrent_map : public std::map<K, V, C, A> {
    using base = std::map<K, V, C, A>;
public:
    using base::base;
    template<typename It> struct basic_range {
        It b, e;
        It begin() const { return b; }
        It end() const { return e; }
        bool empty() const { return b == e; }
        bool is_divisible() const { return false; }
        std::size_t grainsize() const { return 1; }
    };
    using range_type       = basic_range<typename base::iterator>;
    using const_range_type = basic_range<typename base::const_iterator>;
    range_type range() { return {base::begin(), base::end()}; }
    const_range_type range() const { return {base::begin(), base::end()}; }
    template<typename Key> auto unsafe_erase(const Key &k) { return base::erase(k); }
};
template<typename K, typename C = std::less<K>, typename A = std::allocator<K>>
class concurrent_set : public std::set<K, C, A> {
    using base = std::set<K, C, A>;
public:
    using base::base;
    template<typename Key> auto unsafe_erase(const Key &k) { return base::erase(k); }
};

template<typename T, typename A = std::allocator<T>>
class concurrent_queue {
public:
    void push(const T &v) { m_q.push_back(v); }
    void push(T &&v) { m_q.push_back(std::move(v)); }
    bool try_pop(T &out) { if (m_q.empty()) return false; out = std::move(m_q.front()); m_q.pop_front(); return true; }
    bool empty() const { return m_q.empty(); }
    std::size_t unsafe_size() const { return m_q.size(); }
    void clear() { m_q.clear(); }
private:
    std::deque<T, A> m_q;
};

class tick_count {
public:
    class interval_t {
    public:
        explicit interval_t(double s = 0) : m_s(s) {}
        double seconds() const { return m_s; }
    private:
        double m_s;
    };
    static tick_count now() { tick_count t; t.m_t = std::chrono::steady_clock::now(); return t; }
    interval_t operator-(const tick_count &o) const { return interval_t(std::chrono::duration<double>(m_t - o.m_t).count()); }
private:
    std::chrono::steady_clock::time_point m_t{};
};

class task_group_context {
public:
    bool cancel_group_execution() { m_cancelled = true; return true; }
    bool is_group_execution_cancelled() const { return m_cancelled; }
private:
    bool m_cancelled = false;
};
using captured_exception = std::exception;

// ── scalable allocation (tbbmalloc) ──────────────────────────────────────────
template<typename T> using scalable_allocator = std::allocator<T>;
template<typename T> using cache_aligned_allocator = std::allocator<T>;

} // namespace tbb

namespace oneapi { namespace tbb = ::tbb; }

extern "C" {
inline void *scalable_malloc(std::size_t n) { return std::malloc(n); }
inline void  scalable_free(void *p) { std::free(p); }
inline void *scalable_realloc(void *p, std::size_t n) { return std::realloc(p, n); }
inline void *scalable_calloc(std::size_t c, std::size_t n) { return std::calloc(c, n); }
inline void *scalable_aligned_malloc(std::size_t n, std::size_t align) { return std::aligned_alloc(align, (n + align - 1) / align * align); }
inline void  scalable_aligned_free(void *p) { std::free(p); }
}
