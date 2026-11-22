#include "PortableSort.hpp"
#include <algorithm>
#include <cstdio>
#include <random>
#include <vector>
struct E { int key; int id; };
int main(){
  std::mt19937 rng(1); int bad=0, runs=0;
  for (int n: {0,1,2,3,5,15,16,17,18,31,32,33,100,181,1000,4097,20000})
    for (int keys: {1,2,3,7,50,100000})
      for (int pattern=0; pattern<6; ++pattern) for (int rep=0; rep<20; ++rep) {
        std::vector<E> v(n);
        for (int i=0;i<n;i++){ int k;
          switch(pattern){case 0:k=rng()%keys;break;case 1:k=i%keys;break;case 2:k=(n-i)%keys;break;case 3:k=(i*7919)%keys;break;case 4:k= (i<n/2? i: n-i)%keys;break;default:k=keys-1-(i%keys);}
          v[i]={k,i}; }
        auto a=v, b=v; auto cmp=[](const E&x,const E&y){return x.key<y.key;};
        std::sort(a.begin(),a.end(),cmp); Slic3r::portable_sort(b.begin(),b.end(),cmp); ++runs;
        for (int i=0;i<n;i++) if (a[i].id!=b[i].id){ bad++; if(bad<4) printf("mismatch n=%d keys=%d pat=%d at %d\n",n,keys,pattern,i); break; }
      }
  // adversarial: median-of-3 killer to force the heap-sort fallback
  { int n=1<<14; std::vector<int> v(n); for(int i=0;i<n;i++) v[i]=i; 
    for (int k=0;k<n/2;k++){ std::swap(v[k*2%n], v[n-1-k]); }
    std::vector<E> a(n),b; for(int i=0;i<n;i++) a[i]={v[i]%13,i}; b=a; auto cmp=[](const E&x,const E&y){return x.key<y.key;};
    std::sort(a.begin(),a.end(),cmp); Slic3r::portable_sort(b.begin(),b.end(),cmp); for(int i=0;i<n;i++) if(a[i].id!=b[i].id){bad++;break;} ++runs; }
  printf("%d runs: %s\n", runs, bad? "MISMATCH": "identical to libstdc++ std::sort");
  return bad!=0;
}
