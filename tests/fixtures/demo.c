#include <stdio.h>
#include <stdlib.h>

__attribute__((noinline)) static int classify(int x) {
  if (x % 3 == 0)
    return x * 2;
  if (x % 5 == 0)
    return x / 5;
  return x - 1;
}

__attribute__((noinline)) static long mix(long v) {
  switch (v & 3) {
  case 0:
    return v + 7;
  case 1:
    return v ^ 0x55;
  case 2:
    return v * 3;
  default:
    return v - 11;
  }
}

int main(int argc, char **argv) {
  long n = argc > 1 ? atol(argv[1]) : 200000;
  long sum = 0;
  for (long i = 0; i < n; i++) {
    if (i % 7 == 0)
      sum += classify((int)i);
    else
      sum += mix(i);
  }
  printf("%ld\n", sum);
  return 0;
}
