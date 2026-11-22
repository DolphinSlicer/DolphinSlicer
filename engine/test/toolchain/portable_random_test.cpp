#include "PortableRandom.hpp"
#include <random>
#include <algorithm>
#include <cstdio>
#include <limits>
#include <vector>
#include <numeric>
using namespace Slic3r::portable_random;
template<class E> int check_engine(const char* name){
  int bad=0;
  for (uint64_t seed: {0ull, 1ull, 27644437ull, 42ull}) {
    // uniform_int
    for (long hi: {0L,1L,2L,5L,7L,100L,1000003L,(long)UINT32_MAX,(long)UINT32_MAX+7L}) for (int rep=0;rep<50;rep++){
      E a(seed+rep), b(seed+rep);
      auto x = std::uniform_int_distribution<long>(0,hi)(a); auto y = uniform_int<long>(b,0L,hi);
      auto x2 = a(); auto y2 = b();
      if (x!=y || x2!=y2) { if(bad<5) printf("%s int hi=%ld %ld %ld\n",name,hi,x,y); bad++; }
    }
    { E a(seed), b(seed); for(int i=0;i<2000;i++){ int lo=-50,hi=i%97; if (std::uniform_int_distribution<int>(lo,hi)(a)!=uniform_int<int>(b,lo,hi)) {bad++; break;} } }
    // canonical / uniform_real
    { E a(seed), b(seed); std::uniform_real_distribution<double> d; for(int i=0;i<5000;i++){ double p=d(a), q=uniform_real<double>(b); if (p!=q){ if(bad<5)printf("%s real %.17g %.17g\n",name,p,q); bad++; break;} } }
    { E a(seed), b(seed); std::uniform_real_distribution<float> d(-2.f,3.f); for(int i=0;i<5000;i++){ float p=d(a), q=uniform_real<float>(b,-2.f,3.f); if (p!=q){ if(bad<5)printf("%s realf %.9g %.9g\n",name,p,q); bad++; break;} } }
    // shuffle
    for (size_t n: {0ul,1ul,2ul,3ul,10ul,11ul,1000ul,100001ul}) { std::vector<size_t> v(n),w(n); std::iota(v.begin(),v.end(),0); w=v; E a(seed), b(seed);
      std::shuffle(v.begin(),v.end(),a); Slic3r::portable_random::shuffle(w.begin(),w.end(),b); if(v!=w || a()!=b()){ if(bad<5)printf("%s shuffle n=%zu\n",name,n); bad++; } }
  }
  printf("%s: %s\n", name, bad? "MISMATCH":"identical to libstdc++");
  return bad;
}
int main(){ return check_engine<std::mt19937_64>("mt19937_64") + check_engine<std::mt19937>("mt19937") + check_engine<std::minstd_rand>("minstd_rand"); }
