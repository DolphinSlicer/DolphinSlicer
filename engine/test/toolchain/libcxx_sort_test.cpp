#include "PortableSort.hpp"
#include <algorithm>
#include <cstdio>
#include <random>
#include <vector>
#include <deque>
struct E { int key; int id; };
int main(){
  std::mt19937 rng(1); int bad=0, runs=0;
  for (int n: {0,1,2,3,5,15,16,17,18,31,33,100,181,1000,4097,20000}) for (int keys: {1,2,3,7,50,100000}) for (int rep=0; rep<30; ++rep) {
    std::vector<E> v(n); for (int i=0;i<n;i++) v[i]={int(rng()%keys),i};
    auto a=v,b=v; auto cmp=[](const E&x,const E&y){return x.key<y.key;};
    std::sort(a.begin(),a.end(),cmp); Slic3r::portable_sort(b.begin(),b.end(),cmp); ++runs;
    for (int i=0;i<n;i++) if(a[i].id!=b[i].id){bad++;break;}
    std::deque<E> d(v.begin(),v.end()); std::sort(d.begin(),d.end(),cmp); for (int i=0;i<n;i++) if(d[i].id!=b[i].id){bad++;break;}
  }
  std::vector<int> x{5,3,1,4,2}; std::sort(x.begin(),x.end()); 
  printf("%d runs: %s (%d%d%d%d%d)\n", runs, bad?"MISMATCH":"libc++ std::sort == libstdc++ order", x[0],x[1],x[2],x[3],x[4]);
  return bad!=0;
}
