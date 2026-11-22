// Desktop's support painting (GLGizmoFdmSupports, GLGizmoPainterBase): support enforcers and
// blockers painted on an object's model parts with desktop's TriangleSelector. The browser's view
// sends the rays under the pointer and the tool's settings; it gets back the painted triangles to
// draw and, when done, the paint in desktop's 3MF form, which orca_set_layout applies for slicing.
// SPDX-License-Identifier: AGPL-3.0-or-later
#include "orca_engine.h"
#include "engine_internal.hpp"

#include <libslic3r/AABBMesh.hpp>
#include <libslic3r/Geometry.hpp>
#include <libslic3r/Model.hpp>
#include <libslic3r/Polyline.hpp>
#include <libslic3r/TriangleSelector.hpp>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <memory>
#include <optional>
#include <queue>
#include <set>
#include <string>
#include <vector>

using namespace Slic3r;
using json = nlohmann::json;

namespace orca_bridge {

using Data = TriangleSelector::TriangleSplittingData;

// FacetsAnnotation::get_triangle_as_string for each triangle of the data.
json facets_to_json(const Data &data)
{
    json out = json::array();
    const auto &tri = data.triangles_to_split;
    for (size_t i = 0; i < tri.size(); ++i) {
        int offset = tri[i].bitstream_start_idx;
        const int end = i + 1 == tri.size() ? int(data.bitstream.size()) : tri[i + 1].bitstream_start_idx;
        std::string s;
        while (offset < end) {
            int code = 0;
            for (int b = 3; b >= 0; --b) code = (code << 1) | int(data.bitstream[offset + b]);
            offset += 4;
            s.insert(s.begin(), char(code < 10 ? '0' + code : 'A' + code - 10));
        }
        out.push_back(json::array({tri[i].triangle_idx, s}));
    }
    return out;
}

// FacetsAnnotation::set_triangle_from_string for each triangle, checked.
bool facets_from_json(Data &data, const json &j, size_t triangles)
{
    data = Data();
    if (j.is_null()) return true;
    if (!j.is_array()) return false;
    int last = -1;
    for (const json &e : j) {
        if (!e.is_array() || e.size() != 2 || !e[0].is_number_integer() || !e[1].is_string()) return false;
        const int idx = e[0].get<int>();
        const std::string s = e[1].get<std::string>();
        const bool hex = !s.empty() && std::all_of(s.begin(), s.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'F'); });
        if (idx <= last || size_t(idx) >= triangles || !hex) return false;
        const size_t start = data.bitstream.size();
        data.triangles_to_split.emplace_back(idx, int(start));
        for (auto it = s.crbegin(); it != s.crend(); ++it) {
            const int dec = *it <= '9' ? *it - '0' : 10 + *it - 'A';
            for (int b = 0; b < 4; ++b) data.bitstream.push_back(bool(dec & (1 << b)));
        }
        if (!data.update_used_states(start)) return false;
        last = idx;
    }
    return true;
}

void set_volume_facets(FacetsAnnotation &facets, const json &j)
{
    facets.reset();
    if (j.is_array())
        for (const json &e : j) facets.set_triangle_from_string(e[0].get<int>(), e[1].get<std::string>());
}

} // namespace orca_bridge

namespace {

using orca_bridge::facets_from_json;
using orca_bridge::facets_to_json;

// Desktop's TriangleSelectorPatch (GLGizmoPainterBase.cpp) without the drawing: the painted
// triangles by state, and Gap fill, which gives small patches the state around them.
class PaintSelector : public TriangleSelector
{
public:
    using TriangleSelector::TriangleSelector;

    struct Patch
    {
        std::vector<int>              facets;
        EnforcerBlockerType           type = EnforcerBlockerType::NONE;
        std::set<EnforcerBlockerType> neighbor_types;
        double                        area = 0.;
    };

    // TriangleSelectorPatch::update_triangles_per_patch: connected triangles of one state. Areas
    // stop adding up at `max_area` (desktop's GapAreaMax), as desktop's.
    std::vector<Patch> patches(double max_area) const
    {
        auto [neighbors, neighbors_propagated] = this->precompute_all_neighbors();
        std::vector<bool> visited(m_triangles.size(), false);
        auto touching = [&](int facet_idx) {
            std::vector<int> out;
            const Vec3i32 &n = neighbors[facet_idx];
            const auto    &v = m_triangles[facet_idx].verts_idxs;
            append_touching_subtriangles(n(0), v[1], v[0], out);
            append_touching_subtriangles(n(1), v[2], v[1], out);
            append_touching_subtriangles(n(2), v[0], v[2], out);
            for (int idx : neighbors_propagated[facet_idx])
                if (idx != -1 && !m_triangles[idx].is_split()) out.push_back(idx);
            return out;
        };
        std::vector<Patch> out;
        size_t start = 0;
        for (;;) {
            while (start < visited.size() && (visited[start] || !m_triangles[start].valid() || m_triangles[start].is_split())) ++start;
            if (start >= m_triangles.size()) break;
            Patch patch;
            patch.type = m_triangles[start].get_state();
            std::queue<int> queue;
            queue.push(int(start));
            while (!queue.empty()) {
                const int cur = queue.front();
                queue.pop();
                if (!visited[cur]) {
                    patch.facets.push_back(cur);
                    if (patch.area < max_area) {
                        const auto &v = m_triangles[cur].verts_idxs;
                        const Vec3f a = m_vertices[v[0]].v, b = m_vertices[v[1]].v, c = m_vertices[v[2]].v;
                        patch.area += std::abs((a - b).cross(a - c).norm()) / 2.;
                    }
                    for (int t : touching(cur)) {
                        if (t < 0) continue;
                        if (m_triangles[t].get_state() != patch.type) { patch.neighbor_types.insert(m_triangles[t].get_state()); continue; }
                        if (!visited[t]) queue.push(t);
                    }
                }
                visited[cur] = true;
            }
            out.push_back(std::move(patch));
        }
        return out;
    }

    // TriangleSelectorPatch::update_selector_triangles.
    void gap_fill(double gap_area)
    {
        for (const Patch &p : patches(GapAreaMax))
            if (p.area < gap_area && !p.neighbor_types.empty())
                for (int f : p.facets) m_triangles[f].set_state(*p.neighbor_types.begin());
    }

    // What each triangle is drawn as (-1: not drawn): 0 enforcers, 1 blockers; seed fill's
    // selection (the fill tool's preview) 2 unpainted, 3 enforcers, 4 blockers. With Gap fill on,
    // the states Gap fill would give (desktop draws its preview so).
    std::vector<int8_t> drawn(std::optional<double> gap_area) const
    {
        std::vector<int8_t> out(m_triangles.size(), -1);
        auto group_of = [](EnforcerBlockerType s) -> int8_t { return s == EnforcerBlockerType::ENFORCER ? 0 : s == EnforcerBlockerType::BLOCKER ? 1 : -1; };
        if (gap_area) {
            for (const Patch &p : patches(GapAreaMax)) {
                const int8_t g = group_of(p.area < *gap_area && !p.neighbor_types.empty() ? *p.neighbor_types.begin() : p.type);
                for (int f : p.facets) out[f] = g;
            }
            return out;
        }
        for (size_t i = 0; i < m_triangles.size(); ++i) {
            const Triangle &t = m_triangles[i];
            if (!t.valid() || t.is_split()) continue;
            const int8_t g = group_of(t.get_state());
            out[i] = t.is_selected_by_seed_fill() ? int8_t(g < 0 ? 2 : 3 + g) : g;
        }
        return out;
    }

    // Original triangles per block: the view gets the blocks whose drawing changed.
    static constexpr int Block = 2048;
    size_t blocks() const { return size_t(m_orig_size_indices + Block - 1) / Block; }

    // A fingerprint of each block's drawing (0: nothing drawn there).
    std::vector<uint64_t> fingerprints(const std::vector<int8_t> &drawn) const
    {
        std::vector<uint64_t> out(blocks(), 0);
        for (size_t i = 0; i < drawn.size(); ++i) {
            if (drawn[i] < 0) continue;
            uint64_t &h = out[size_t(m_triangles[i].source_triangle) / Block];
            if (h == 0) h = 1469598103934665603ull;
            h = (h ^ (uint64_t(i) * 8 + uint64_t(drawn[i]) + 1)) * 1099511628211ull;
        }
        return out;
    }

    // The triangles of the blocks in `slot` (>= 0), in object coordinates, by block and group.
    void collect(const std::vector<int8_t> &drawn, const std::vector<int> &slot, std::vector<std::array<std::vector<float>, 5>> &out, const Transform3f &to_object) const
    {
        for (size_t i = 0; i < drawn.size(); ++i) {
            if (drawn[i] < 0) continue;
            const int s = slot[size_t(m_triangles[i].source_triangle) / Block];
            if (s < 0) continue;
            std::vector<float> &v = out[s][drawn[i]];
            for (int k : m_triangles[i].verts_idxs) {
                const Vec3f p = to_object * m_vertices[k].v;
                v.push_back(p.x());
                v.push_back(p.y());
                v.push_back(p.z());
            }
        }
    }

    /**
     * TriangleSelector::seed_fill_select_triangles (Smart fill), the same steps with the normal
     * matrix worked out once instead of for each triangle visited; without a clipping plane.
     */
    void seed_fill(const Vec3f &hit, int facet_start, const Transform3d &trafo_no_translate, float seed_fill_angle,
                   float highlight_by_angle_deg, const Vec3f &up_direction, bool force_reselection)
    {
        if (int start = select_unsplit_triangle(hit, facet_start); start >= 0 && m_triangles[start].is_selected_by_seed_fill() && !force_reselection)
            return;
        this->seed_fill_unselect_all_triangles();
        std::vector<bool> visited(m_triangles.size(), false);
        std::queue<int>   queue;
        queue.push(facet_start);
        const double   facet_angle_limit     = cos(Geometry::deg2rad(seed_fill_angle)) - EPSILON;
        const float    highlight_angle_limit = -cos(Geometry::deg2rad(highlight_by_angle_deg));
        const Matrix3f normal_matrix         = static_cast<Matrix3f>(trafo_no_translate.matrix().block(0, 0, 3, 3).inverse().transpose().cast<float>());
        while (!queue.empty()) {
            const int cur = queue.front();
            queue.pop();
            const Vec3f &facet_normal = m_face_normals[m_triangles[cur].source_triangle];
            if (!visited[cur] && (highlight_by_angle_deg == 0.f || (normal_matrix * facet_normal).normalized().dot(up_direction) < highlight_angle_limit)) {
                if (m_triangles[cur].is_split()) {
                    for (int i = 0; i <= m_triangles[cur].number_of_split_sides(); ++i)
                        if (int child = m_triangles[cur].children[i]; !visited[child]) queue.push(child);
                } else
                    m_triangles[cur].select_by_seed_fill();
                if (cur < m_orig_size_indices)
                    for (int n : m_neighbors[cur])
                        if (n >= 0 && !visited[n]) {
                            const Vec3f &n1 = m_face_normals[m_triangles[n].source_triangle];
                            if (std::clamp(n1.dot(facet_normal), 0.f, 1.f) >= facet_angle_limit) queue.push(n);
                        }
            }
            visited[cur] = true;
        }
    }

    /** The unsplit triangle at the hit is in the fill's preview. */
    bool seed_selected(const Vec3f &hit, int facet) const
    {
        const int t = select_unsplit_triangle(hit, facet);
        return t >= 0 && m_triangles[t].is_selected_by_seed_fill();
    }

    static constexpr double GapAreaMax = 5.;
};

struct Part
{
    std::unique_ptr<TriangleMesh>  mesh;   // the volume's mesh; the selector keeps a reference
    std::unique_ptr<PaintSelector> sel;
    std::unique_ptr<AABBMesh>      aabb;
    Transform3d                    volume; // volume → object
    std::vector<uint64_t>          sent;   // the fingerprints of the blocks as last sent to the view
    TriangleSelector::TriangleSplittingData loaded; // the paint as the model has it
};

struct Painter
{
    std::vector<Part>        parts;
    std::vector<Transform3d> instances = {Transform3d::Identity()};
    std::string              scratch;
    std::vector<float>       render;
    std::optional<double>    gap_preview;
    /** The part the fill's preview is on (desktop's m_seed_fill_last_mesh_id), -1: none. */
    int                      seed_part = -1;
    const char *ret(std::string s) { scratch = std::move(s); return scratch.c_str(); }
};

Painter *as_painter(void *p) { return static_cast<Painter *>(p); }

struct Hit
{
    int    part = -1, instance = 0, facet = 0;
    Vec3f  point = Vec3f::Zero(), normal = Vec3f::Zero();   // mesh coordinates
    double dist2 = 0.;
};

bool read_vec3(const json &j, Vec3d &out)
{
    if (!j.is_array() || j.size() != 3) return false;
    for (int i = 0; i < 3; ++i) { if (!j[i].is_number()) return false; out[i] = j[i].get<double>(); }
    return true;
}

bool read_matrix(const json &j, Transform3d &out)
{
    if (!j.is_array() || j.size() != 16) return false;
    for (int c = 0; c < 4; ++c)
        for (int r = 0; r < 4; ++r) {
            if (!j[c * 4 + r].is_number()) return false;
            out.matrix()(r, c) = j[c * 4 + r].get<double>();
        }
    return true;
}

Transform3d trafo_of(const Painter &p, int part, int instance) { return p.instances[instance] * p.parts[part].volume; }

Transform3d no_translation(const Transform3d &t)
{
    Transform3d out = Transform3d::Identity();
    out.linear() = t.linear();
    return out;
}

// GLGizmoPainterBase::update_raycast_cache with MeshRaycaster::unproject_on_mesh: the hit closest
// to the camera on any part of any instance; not below the bed, and not from inside a mesh.
Hit raycast(const Painter &p, const Vec3d &origin, const Vec3d &dir, const Vec3d &camera)
{
    Hit best;
    best.dist2 = std::numeric_limits<double>::max();
    for (int k = 0; k < int(p.instances.size()); ++k)
        for (int i = 0; i < int(p.parts.size()); ++i) {
            const Transform3d trafo = trafo_of(p, i, k);
            const Transform3d inv   = trafo.inverse();
            const std::vector<AABBMesh::hit_result> hits = p.parts[i].aabb->query_ray_hits(inv * origin, inv.linear() * dir);
            size_t h = 0;
            while (h < hits.size() && (trafo * hits[h].position()).z() < SINKING_Z_THRESHOLD) ++h;
            if (h == hits.size() || (hits.size() - h) % 2 != 0) continue;
            const double d2 = (camera - trafo * hits[h].position()).squaredNorm();
            if (d2 < best.dist2) {
                best = {i, k, int(hits[h].face()), hits[h].position().cast<float>(), hits[h].normal().cast<float>(), d2};
            }
        }
    if (best.part < 0) best.dist2 = 0.;
    return best;
}

// GLGizmoPainterBase::get_projected_mouse_positions after the rays are cast: runs of hits on one
// part, a run on one facet as its ends, a longer one simplified in the plane of its points.
std::vector<std::vector<Hit>> group_hits(const Painter &p, std::vector<Hit> hits, float cursor_radius)
{
    std::vector<std::vector<Hit>> groups;
    for (size_t prev = 0, cur = 0; cur < hits.size(); ++cur) {
        const size_t next = cur + 1;
        if (next >= hits.size() || hits[cur].part != hits[next].part || hits[cur].instance != hits[next].instance) {
            groups.emplace_back(hits.begin() + prev, hits.begin() + next);
            prev = next;
        }
    }
    for (std::vector<Hit> &g : groups) {
        if (g.back().part == -1) break;
        if (g.size() <= 2) continue;
        if (std::all_of(g.begin(), g.end(), [&](const Hit &h) { return h.facet == g.front().facet; })) { g = {g.front(), g.back()}; continue; }
        // A plane through three of the points that are not on a line.
        std::optional<std::array<Vec3d, 3>> plane;
        for (size_t t = 2; t < g.size() && !plane; ++t) {
            const Vec3d a = g[t - 2].point.cast<double>(), b = g[t - 1].point.cast<double>(), c = g[t].point.cast<double>();
            const Vec3d v1 = a - b, v2 = c - b;
            if (v1.cross(v2).squaredNorm() > sqr(EPSILON)) {
                const Vec3d x = v1.normalized();
                const Vec3d y = (v2 - (v1.dot(v2) / v1.dot(v1)) * v1).normalized();
                plane = std::array<Vec3d, 3>{b, x, y};
            }
        }
        if (!plane) { g = {g.front(), g.back()}; continue; }
        const auto &[origin, x, y] = *plane;
        Polyline line;
        for (const Hit &h : g) {
            const Vec3d q = h.point.cast<double>();
            line.points.emplace_back(scale_(x.dot(q - origin)), scale_(y.dot(q - origin)));
        }
        line.simplify(scale_(cursor_radius) / 10.);
        std::vector<Hit> simplified;
        for (const Point &pt : line.points) {
            Hit h = g.front();
            const Vec3d q = origin + unscale<double>(pt.x()) * x + unscale<double>(pt.y()) * y;
            h.point = q.cast<float>();
            int idx = 0;
            Vec3d closest;
            p.parts[h.part].aabb->squared_distance(q, idx, closest);
            h.facet = idx;
            simplified.push_back(h);
        }
        g = std::move(simplified);
    }
    return groups;
}

json point_json(const Vec3d &v) { return json::array({v.x(), v.y(), v.z()}); }

} // namespace

extern "C" {

void *orca_paint_open(void *engine, const char *json_text)
{
    try {
        Model *model = orca_bridge::engine_model(engine);
        const json j = json::parse(json_text ? json_text : "", nullptr, false);
        if (!model || !j.is_object() || !j.value("object", json()).is_number_unsigned()) {
            orca_bridge::engine_fail(engine, ORCA_INVALID_INPUT, "Paint: must be {object, instances, supports?}");
            return nullptr;
        }
        const size_t idx = j["object"].get<size_t>();
        if (idx >= model->objects.size()) { orca_bridge::engine_fail(engine, ORCA_INVALID_INPUT, "Paint: no such object"); return nullptr; }
        const ModelObject *mo = model->objects[idx];
        auto p = std::make_unique<Painter>();
        if (const json &ins = j.value("instances", json()); ins.is_array() && !ins.empty()) {
            p->instances.clear();
            for (const json &m : ins) {
                Transform3d t = Transform3d::Identity();
                if (!read_matrix(m, t)) { orca_bridge::engine_fail(engine, ORCA_INVALID_INPUT, "Paint: an instance matrix must be 16 numbers"); return nullptr; }
                p->instances.push_back(t);
            }
        }
        const json &given = j.value("supports", json());
        int k = -1;
        for (const ModelVolume *mv : mo->volumes) {
            if (!mv->is_model_part()) continue;
            ++k;
            Part part;
            part.mesh   = std::make_unique<TriangleMesh>(mv->mesh());
            part.volume = mv->get_matrix();
            part.aabb   = std::make_unique<AABBMesh>(*part.mesh);
            // As desktop's GLGizmoFdmSupports::update_from_model_object.
            part.sel = std::make_unique<PaintSelector>(*part.mesh);
            if (given.is_array()) {
                TriangleSelector::TriangleSplittingData data;
                if (size_t(k) < given.size() && !facets_from_json(data, given[k], part.mesh->its.indices.size())) {
                    orca_bridge::engine_fail(engine, ORCA_INVALID_INPUT, "Paint: the painted facets don't fit the object");
                    return nullptr;
                }
                part.sel->deserialize(data, false, EnforcerBlockerType::BLOCKER);
            } else {
                part.sel->deserialize(mv->supported_facets.get_data(), false, EnforcerBlockerType::BLOCKER);
            }
            part.loaded = mv->supported_facets.get_data();
            p->parts.push_back(std::move(part));
        }
        return p.release();
    } catch (const std::bad_alloc &) {
        orca_bridge::engine_fail(engine, ORCA_OOM, "Out of memory while preparing to paint");
    } catch (const std::exception &ex) {
        orca_bridge::engine_fail(engine, ORCA_INTERNAL, "Could not prepare to paint", ex.what());
    }
    return nullptr;
}

void orca_paint_close(void *p) { delete as_painter(p); }

const char *orca_paint_event(void *pp, const char *json_text)
{
    Painter &p = *as_painter(pp);
    try {
        const json j = json::parse(json_text ? json_text : "", nullptr, false);
        if (!j.is_object()) return p.ret(R"({"error":"bad event"})");
        if (const json &ins = j.value("instances", json()); ins.is_array() && !ins.empty()) {
            std::vector<Transform3d> list;
            for (const json &m : ins) {
                Transform3d t = Transform3d::Identity();
                if (!read_matrix(m, t)) return p.ret(R"({"error":"bad instance"})");
                list.push_back(t);
            }
            p.instances = std::move(list);
        }
        const std::string action = j.value("action", "");
        const std::string tool   = j.value("tool", "circle");
        Vec3d camera = Vec3d::Zero();
        read_vec3(j.value("camera", json()), camera);
        const float radius     = float(j.value("radius", 1.0));
        const float fill_angle = float(j.value("smart_fill_angle", 30.0));
        // Desktop's get_highlight_angle_limit_deg when painting on overhangs only, else 0.
        const float overhang   = float(j.value("overhang_limit", 0.0));
        const bool  fill       = tool == "fill";
        std::vector<Hit> hits;
        for (const json &r : j.value("rays", json::array())) {
            if (!r.is_array() || r.size() != 6) continue;
            const Vec3d o(r[0].get<double>(), r[1].get<double>(), r[2].get<double>()), d(r[3].get<double>(), r[4].get<double>(), r[5].get<double>());
            hits.push_back(raycast(p, o, d, camera));
            if (hits.back().part == -1) break;   // as desktop: only the last may miss
        }
        json out = {{"hit", false}, {"changed", false}};
        if (!hits.empty() && hits.front().part >= 0) {
            const Hit &h = hits.front();
            const Transform3d trafo = trafo_of(p, h.part, h.instance);
            out["hit"]    = true;
            out["point"]  = point_json(trafo * h.point.cast<double>());
            out["normal"] = point_json((trafo.linear().inverse().transpose() * h.normal.cast<double>()).normalized());
        }
        // The fill's preview cleared (another tool or angle: desktop unselects it then).
        if (action == "clear") {
            for (Part &pt : p.parts) pt.sel->seed_fill_unselect_all_triangles();
            out["changed"] = p.seed_part >= 0;
            p.seed_part = -1;
            return p.ret(out.dump());
        }
        if (action == "move") {
            // The fill tool's preview: what a click would fill (desktop's Moving event). It stays
            // while the pointer is on it; another part or none clears it.
            if (fill) {
                const bool hit = !hits.empty() && hits.front().part >= 0;
                const int  part = hit ? hits.front().part : -1;
                if (!hit || part != p.seed_part) {
                    if (p.seed_part >= 0 || !hit) {
                        for (Part &pt : p.parts) pt.sel->seed_fill_unselect_all_triangles();
                        out["changed"] = p.seed_part >= 0;
                    }
                }
                p.seed_part = part;
                if (hit) {
                    const Hit &h = hits.front();
                    PaintSelector &sel = *p.parts[h.part].sel;
                    // As seed_fill_select_triangles without forcing: nothing to do on the preview.
                    if (!sel.seed_selected(h.point, h.facet)) {
                        const Transform3d nt = no_translation(trafo_of(p, h.part, h.instance));
                        sel.seed_fill(h.point, h.facet, nt, fill_angle, overhang, Vec3f::UnitZ(), false);
                        out["changed"] = true;
                    }
                }
            }
            return p.ret(out.dump());
        }
        if (action != "down" && action != "drag") return p.ret(out.dump());
        // GLGizmoPainterBase::gizmo_event for LeftDown, RightDown and Dragging.
        const EnforcerBlockerType state = j.value("erase", false) ? EnforcerBlockerType::NONE
            : j.value("button", "left") == "right" ? EnforcerBlockerType::BLOCKER : EnforcerBlockerType::ENFORCER;
        const auto type = tool == "sphere" ? TriangleSelector::CursorType::SPHERE : TriangleSelector::CursorType::CIRCLE;
        for (const std::vector<Hit> &g : group_hits(p, hits, radius)) {
            if (g.front().part == -1) break;
            const Hit &first = g.front();
            Part &part = p.parts[first.part];
            const Transform3d trafo = trafo_of(p, first.part, first.instance);
            const Transform3d nt    = no_translation(trafo);
            const Vec3f cam = (trafo.inverse() * camera).cast<float>();
            const TriangleSelector::ClippingPlane clp;
            if (fill) {
                p.seed_part = first.part;
                for (const Hit &h : g) {
                    part.sel->seed_fill_apply_on_triangles(state);
                    part.sel->seed_fill(h.point, h.facet, nt, fill_angle, overhang, Vec3f::UnitZ(), true);
                }
            } else if (g.size() == 1) {
                part.sel->select_patch(first.facet, TriangleSelector::SinglePointCursor::cursor_factory(first.point, cam, radius, type, trafo, clp),
                                       state, nt, true, overhang, Vec3f::UnitZ());
            } else {
                for (size_t i = 0; i + 1 < g.size(); ++i)
                    part.sel->select_patch(g[i].facet, TriangleSelector::DoublePointCursor::cursor_factory(g[i].point, g[i + 1].point, cam, radius, type, trafo, clp),
                                           state, nt, true, overhang, Vec3f::UnitZ());
            }
            out["changed"] = true;
        }
        return p.ret(out.dump());
    } catch (const std::exception &ex) {
        return p.ret(json{{"error", ex.what()}}.dump());
    }
}

// The triangles to draw that changed since the last call, in object coordinates, by block of
// the original triangles; read by the host from memory: {"ptr": address of the floats, "full":
// the first (all blocks with something drawn), "blocks": [{part, block, counts: [floats per
// group ×5]}]}. A block with all counts 0 has nothing drawn any more.
const char *orca_paint_render(void *pp)
{
    Painter &p = *as_painter(pp);
    p.render.clear();
    json blocks = json::array();
    bool full = true;
    for (size_t k = 0; k < p.parts.size(); ++k) {
        Part &part = p.parts[k];
        full = full && part.sent.empty();
        const std::vector<int8_t>   drawn = part.sel->drawn(p.gap_preview);
        const std::vector<uint64_t> now   = part.sel->fingerprints(drawn);
        std::vector<int> slot(now.size(), -1), changed;
        for (size_t b = 0; b < now.size(); ++b)
            if (part.sent.empty() ? now[b] != 0 : now[b] != part.sent[b]) { slot[b] = int(changed.size()); changed.push_back(int(b)); }
        std::vector<std::array<std::vector<float>, 5>> out(changed.size());
        part.sel->collect(drawn, slot, out, part.volume.cast<float>());
        for (size_t c = 0; c < changed.size(); ++c) {
            json counts = json::array();
            for (const std::vector<float> &g : out[c]) { p.render.insert(p.render.end(), g.begin(), g.end()); counts.push_back(g.size()); }
            blocks.push_back({{"part", k}, {"block", changed[c]}, {"counts", std::move(counts)}});
        }
        part.sent = now;
    }
    return p.ret(json{{"ptr", reinterpret_cast<uintptr_t>(p.render.data())}, {"full", full}, {"blocks", std::move(blocks)}}.dump());
}

// Gap fill: {"preview": area} shows what it would do (null: off), {"apply": area} does it.
int orca_paint_gap(void *pp, const char *json_text)
{
    Painter &p = *as_painter(pp);
    const json j = json::parse(json_text ? json_text : "", nullptr, false);
    if (!j.is_object()) return ORCA_INVALID_INPUT;
    if (j.contains("preview")) p.gap_preview = j["preview"].is_number() ? std::optional<double>(j["preview"].get<double>()) : std::nullopt;
    if (j.contains("apply") && j["apply"].is_number())
        for (Part &part : p.parts) part.sel->gap_fill(j["apply"].get<double>());
    return ORCA_OK;
}

// Erase all (desktop's "Erase all").
void orca_paint_reset(void *pp)
{
    for (Part &part : as_painter(pp)->parts) part.sel->reset();
}

// Other paint on the same object (undo, redo): {"supports": [per model part] | null (as loaded)}.
int orca_paint_set(void *pp, const char *json_text)
{
    Painter &p = *as_painter(pp);
    const json j = json::parse(json_text ? json_text : "", nullptr, false);
    if (!j.is_object()) return ORCA_INVALID_INPUT;
    const json &given = j.value("supports", json());
    std::vector<TriangleSelector::TriangleSplittingData> data(p.parts.size());
    for (size_t k = 0; k < p.parts.size(); ++k) {
        if (!given.is_array()) data[k] = p.parts[k].loaded;
        else if (k < given.size() && !facets_from_json(data[k], given[k], p.parts[k].mesh->its.indices.size())) return ORCA_INVALID_INPUT;
    }
    for (size_t k = 0; k < p.parts.size(); ++k) p.parts[k].sel->deserialize(data[k], true, EnforcerBlockerType::BLOCKER);
    p.seed_part = -1;
    return ORCA_OK;
}

// The paint of each model part in desktop's 3MF form: [[[triangle, "hex"], …] per part].
const char *orca_paint_data(void *pp)
{
    Painter &p = *as_painter(pp);
    json out = json::array();
    for (const Part &part : p.parts) {
        part.sel->seed_fill_unselect_all_triangles();
        out.push_back(facets_to_json(part.sel->serialize()));
    }
    return p.ret(out.dump());
}

} // extern "C"
