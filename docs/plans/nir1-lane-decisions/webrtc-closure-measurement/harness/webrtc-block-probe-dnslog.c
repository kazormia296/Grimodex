/**
 * 名前解決の記録層（試作。製品に入れない）。LD_PRELOAD で getaddrinfo を包み、
 * 「時刻(ms)\tpid\t名前\tservice\t戻り値」を env PROBE_DNSLOG の file に追記する。
 * 戻り値は実際の getaddrinfo の戻り値（0 なら実 DNS または hosts で解決できた）。
 * Chromium の network service が getaddrinfo を呼ぶときの host 名を、DNS の resolver へ出る前に観測する。
 *   gcc -shared -fPIC -O2 -o dnslog.so webrtc-block-probe-dnslog.c -ldl
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <netdb.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <unistd.h>

typedef int (*gai_fn)(const char *, const char *, const struct addrinfo *, struct addrinfo **);

int getaddrinfo(const char *node, const char *service, const struct addrinfo *hints, struct addrinfo **res) {
  static gai_fn real = NULL;
  if (!real) real = (gai_fn)dlsym(RTLD_NEXT, "getaddrinfo");
  int rc = real(node, service, hints, res);
  const char *path = getenv("PROBE_DNSLOG");
  if (path && node) {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    char line[1024];
    int n = snprintf(line, sizeof line, "%lld\t%d\t%s\t%s\t%d\n",
                     (long long)tv.tv_sec * 1000 + tv.tv_usec / 1000, (int)getpid(), node,
                     service ? service : "-", rc);
    int fd = open(path, O_WRONLY | O_APPEND | O_CREAT, 0600);
    if (fd >= 0) { if (n > 0) { ssize_t w = write(fd, line, (size_t)n); (void)w; } close(fd); }
  }
  return rc;
}
