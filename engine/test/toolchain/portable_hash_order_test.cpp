#include <algorithm>
#include <iterator>
#include "PortableHashOrder.hpp"
#include <unordered_map>
#include <random>
#include <cstdio>
#include <cmath>
int main(){
  std::mt19937 rng(7); int bad=0, runs=0;
  for (int n=1; n<=300; ++n) for (int rep=0; rep<40; ++rep) {
    std::unordered_map<double,int> m; Slic3r::UnorderedOrderDouble o;
    for (int i=0;i<n;i++){ double k;
      switch(rep%4){ case 0: k=std::ceil(std::atan2(double(int(rng()%2001)-1000), double(int(rng()%2001)-1000))*1000.0); break;
        case 1: k=double(int(rng()%7)-3)*1571.0; break; case 2: k=(rng()%3==0)?0.0:(rng()%2? -0.0: double(rng())); break; default: k=std::ldexp(double(rng()), -int(rng()%40)); }
      bool a=m.emplace(k,i).second, b=o.insert(k); if(a!=b){bad++;}
    }
    std::vector<double> ks; for (auto&kv:m) ks.push_back(kv.first);
    auto ko=o.keys(); ++runs;
    if (ks.size()!=ko.size() || !std::equal(ks.begin(),ks.end(),ko.begin(),[](double x,double y){return x==y;})) { bad++; if (bad<4) printf("mismatch n=%d rep=%d size %zu %zu\n",n,rep,ks.size(),ko.size()); }
  }
  printf("%d runs: %s\n", runs, bad? "MISMATCH":"identical to libstdc++ unordered_map<double> order");
  return bad!=0;
}
