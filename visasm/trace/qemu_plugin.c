#define _GNU_SOURCE
#include <qemu-plugin.h>

#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

QEMU_PLUGIN_EXPORT int qemu_plugin_version = QEMU_PLUGIN_VERSION;

struct TraceHeader {
    uint64_t code_start;
    uint64_t probes;
    uint64_t count;
    uint64_t main_thread;
    uint64_t error;
};

struct TraceEvent {
    uint64_t timestamp;
    uint32_t probe;
    uint32_t thread;
};

_Static_assert(sizeof(struct TraceHeader) == 40, "unexpected trace header layout");
_Static_assert(sizeof(struct TraceEvent) == 16, "unexpected trace event layout");

static struct TraceHeader *trace;
static const uint64_t *addresses;
static pthread_mutex_t storage_lock = PTHREAD_MUTEX_INITIALIZER;
static const char *trace_path;
static char *storage;
static size_t storage_size;
static size_t records_offset;
static bool fork_child;
static _Thread_local uint32_t thread_id;

static void skip_fork_child(void)
{
    fork_child = true;
}

/* Keep the probe table mapped at a stable address for translation callbacks. */
static int grow_storage(void)
{
    const size_t capacity = storage_size - records_offset;
    const size_t growth = capacity < 64 * 1024 ? 64 * 1024 : capacity;
    if (growth > INT64_MAX - storage_size)
        return EOVERFLOW;

    const size_t size = storage_size + growth;
    const int fd = open(trace_path, O_RDWR | O_CLOEXEC);
    if (fd < 0)
        return errno;
    const int error = posix_fallocate(fd, storage_size, growth);
    close(fd);
    if (error)
        return error;
    void *mapping = mremap(storage, storage_size, size, MREMAP_MAYMOVE);
    if (mapping == MAP_FAILED)
        return errno;
    storage = mapping;
    storage_size = size;
    return 0;
}

static void record_entry(unsigned int vcpu, void *probe)
{
    (void)vcpu;
    if (fork_child)
        return;

    struct timespec stamp;
    const int clock_error = clock_gettime(CLOCK_MONOTONIC, &stamp) ? errno : 0;
    if (!thread_id)
        thread_id = gettid();

    pthread_mutex_lock(&storage_lock);
    if (!trace->error) {
        const size_t offset = records_offset + trace->count * sizeof(struct TraceEvent);
        trace->error = clock_error;
        if (!trace->error && storage_size - offset < sizeof(struct TraceEvent))
            trace->error = grow_storage();
        if (!trace->error) {
            struct TraceEvent *event = (struct TraceEvent *)(storage + offset);
            *event = (struct TraceEvent){
                .timestamp = (uint64_t)stamp.tv_sec * 1000000000 + stamp.tv_nsec,
                .probe = (uintptr_t)probe,
                .thread = thread_id,
            };
            trace->count++;
        }
    }
    pthread_mutex_unlock(&storage_lock);
}

static void translate(qemu_plugin_id_t id, struct qemu_plugin_tb *tb)
{
    (void)id;
    if (fork_child)
        return;

    const uint64_t bias = qemu_plugin_start_code() - trace->code_start;
    const size_t count = qemu_plugin_tb_n_insns(tb);
    for (size_t index = 0; index < count; index++) {
        struct qemu_plugin_insn *insn = qemu_plugin_tb_get_insn(tb, index);
        const uint64_t address = qemu_plugin_insn_vaddr(insn) - bias;
        if (address < addresses[0] || address > addresses[trace->probes - 1])
            continue;
        size_t low = 0;
        size_t high = trace->probes;
        while (low < high) {
            const size_t middle = low + (high - low) / 2;
            if (addresses[middle] < address)
                low = middle + 1;
            else
                high = middle;
        }
        if (addresses[low] == address)
            qemu_plugin_register_vcpu_insn_exec_cb(
                insn, record_entry, QEMU_PLUGIN_CB_NO_REGS, (void *)(uintptr_t)low);
    }
}

QEMU_PLUGIN_EXPORT int qemu_plugin_install(qemu_plugin_id_t id,
                                           const qemu_info_t *info,
                                           int argc, char **argv)
{
    if (info->system_emulation || argc != 1 || strncmp(argv[0], "output=", 7) != 0)
        return -1;
    trace_path = argv[0] + 7;
    const int fd = open(trace_path, O_RDWR | O_CLOEXEC);
    if (fd < 0)
        return -1;
    struct stat statbuf;
    if (fstat(fd, &statbuf) || statbuf.st_size < (off_t)sizeof(*trace)) {
        close(fd);
        return -1;
    }

    storage_size = statbuf.st_size;
    trace = mmap(NULL, storage_size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (trace == MAP_FAILED) {
        close(fd);
        return -1;
    }
    const size_t available = storage_size - sizeof(*trace);
    if (!trace->probes || trace->probes > UINT32_MAX ||
        trace->probes * sizeof(*addresses) != available) {
        close(fd);
        munmap(trace, storage_size);
        return -1;
    }
    storage = mmap(NULL, storage_size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    close(fd);
    if (storage == MAP_FAILED || pthread_atfork(NULL, NULL, skip_fork_child)) {
        if (storage != MAP_FAILED)
            munmap(storage, storage_size);
        munmap(trace, storage_size);
        return -1;
    }
    records_offset = storage_size;
    addresses = (const uint64_t *)(trace + 1);
    trace->main_thread = gettid();
    qemu_plugin_register_vcpu_tb_trans_cb(id, translate);
    return 0;
}
