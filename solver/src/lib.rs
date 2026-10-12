use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use wasm_bindgen::prelude::*;

const MAX_ITERATIONS: usize = 100;
const DEFAULT_TOLERANCE: f64 = 1e-6;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
struct Point { x: f64, y: f64 }

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NodeInput { id: String, x: f64, y: f64 }

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct SegmentInput {
    id: String,
    start_node_id: String,
    end_node_id: String,
    #[serde(default)] segment_type: String,
    #[serde(default)] center: Option<Point>,
    #[serde(default)] radius: Option<f64>,
    #[serde(default)] start_angle: Option<f64>,
    #[serde(default)] end_angle: Option<f64>,
    #[serde(default)] clockwise: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ConstraintType {
    Parallel, Perpendicular, Tangent, Symmetric, EqualLength, FixedDistance,
    FixedAngle, FixedRadius, Horizontal, Vertical, Coincident,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Priority { Hard, Medium, Soft }

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConstraintInput {
    id: String,
    #[serde(rename = "type")]
    constraint_type: ConstraintType,
    priority: Priority,
    target_ids: Vec<String>,
    #[serde(default)]
    parameters: BTreeMap<String, f64>,
    #[serde(default = "default_tolerance")]
    tolerance: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SolveInput {
    nodes: Vec<NodeInput>,
    segments: Vec<SegmentInput>,
    constraints: Vec<ConstraintInput>,
    #[serde(default)]
    pinned_node_ids: Vec<String>,
    #[serde(default = "default_tolerance")]
    tolerance: f64,
    #[serde(default = "default_iterations")]
    max_iterations: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NodeOutput { id: String, x: f64, y: f64 }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConflictOutput { constraint_ids: Vec<String>, message: String, error: f64, suggestion: String }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SegmentOutput {
    id: String,
    start_node_id: String,
    end_node_id: String,
    #[serde(rename = "type")]
    segment_type: String,
    center: Point,
    radius: f64,
    start_angle: f64,
    end_angle: f64,
    clockwise: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SolveOutput {
    success: bool,
    adjusted_nodes: Vec<NodeOutput>,
    adjusted_segments: Vec<SegmentOutput>,
    error: f64,
    iterations: usize,
    conflicts: Vec<ConflictOutput>,
}

fn default_tolerance() -> f64 { DEFAULT_TOLERANCE }
fn default_iterations() -> usize { MAX_ITERATIONS }

#[wasm_bindgen]
pub fn solve_json(input_json: &str) -> String {
    match serde_json::from_str::<SolveInput>(input_json) {
        Ok(input) => serde_json::to_string(&solve(input)).unwrap_or_else(|error| failure_json(error.to_string())),
        Err(error) => failure_json(format!("Invalid solver input: {error}")),
    }
}

#[wasm_bindgen]
pub fn solver_version() -> String { "vector-solver/0.1.0 deterministic-f64".to_string() }

fn failure_json(message: String) -> String {
    serde_json::to_string(&SolveOutput {
        success: false,
        adjusted_nodes: vec![],
        adjusted_segments: vec![],
        error: f64::MAX,
        iterations: 0,
        conflicts: vec![ConflictOutput {
            constraint_ids: vec![], message,
            error: f64::MAX,
            suggestion: "Check the serialized graph supplied to the Wasm worker.".into(),
        }],
    }).unwrap()
}

fn solve(mut input: SolveInput) -> SolveOutput {
    input.constraints.sort_by(|a, b| {
        priority_rank(&a.priority).cmp(&priority_rank(&b.priority)).then(a.id.cmp(&b.id))
    });
    let mut positions: BTreeMap<String, Point> = input.nodes.iter()
        .map(|node| (node.id.clone(), Point { x: node.x, y: node.y })).collect();
    let mut segments: BTreeMap<String, SegmentInput> = input.segments.into_iter()
        .map(|segment| (segment.id.clone(), segment)).collect();
    let pinned: BTreeSet<String> = input.pinned_node_ids.into_iter().collect();

    let structural = structural_conflicts(&positions, &segments, &input.constraints);
    if !structural.is_empty() {
        return output(false, &positions, &segments, f64::MAX, 0, structural);
    }

    let mut iterations = 0;
    for index in 0..input.max_iterations {
        for constraint in &input.constraints {
            let weight = priority_weight(&constraint.priority);
            apply_constraint(&mut positions, &mut segments, &pinned, constraint, weight);
        }
        iterations = index + 1;
        let max_error = input.constraints.iter()
            .filter(|constraint| constraint.priority == Priority::Hard)
            .map(|constraint| residual(&positions, &segments, constraint))
            .fold(0.0_f64, f64::max);
        if max_error <= input.tolerance { break; }
    }

    let mut total_error = 0.0;
    let mut conflicts = vec![];
    for constraint in &input.constraints {
        let error = residual(&positions, &segments, constraint);
        total_error += error * priority_weight(&constraint.priority);
        let tolerance = input.tolerance.max(constraint.tolerance);
        if constraint.priority == Priority::Hard && error > tolerance {
            conflicts.push(ConflictOutput {
                constraint_ids: vec![constraint.id.clone()],
                message: format!("{} did not converge within {:.1e} tolerance.", label(&constraint.constraint_type), tolerance),
                error,
                suggestion: "Drop a conflicting constraint, adjust its parameter, or relax it to soft.".into(),
            });
        }
    }
    output(conflicts.is_empty(), &positions, &segments, total_error, iterations, conflicts)
}

fn output(
    success: bool,
    positions: &BTreeMap<String, Point>,
    segments: &BTreeMap<String, SegmentInput>,
    error: f64,
    iterations: usize,
    conflicts: Vec<ConflictOutput>,
) -> SolveOutput {
    SolveOutput {
        success, error, iterations, conflicts,
        adjusted_nodes: positions.iter().map(|(id, point)| NodeOutput { id: id.clone(), x: point.x, y: point.y }).collect(),
        adjusted_segments: segments.values().filter_map(|segment| {
            if segment.segment_type != "arc" { return None; }
            Some(SegmentOutput {
                id: segment.id.clone(),
                start_node_id: segment.start_node_id.clone(),
                end_node_id: segment.end_node_id.clone(),
                segment_type: segment.segment_type.clone(),
                center: segment.center?,
                radius: segment.radius?,
                start_angle: segment.start_angle?,
                end_angle: segment.end_angle?,
                clockwise: segment.clockwise.unwrap_or(false),
            })
        }).collect(),
    }
}

fn apply_constraint(
    positions: &mut BTreeMap<String, Point>,
    segments: &mut BTreeMap<String, SegmentInput>,
    pinned: &BTreeSet<String>,
    constraint: &ConstraintInput,
    weight: f64,
) {
    let id = |index: usize| constraint.target_ids.get(index).map(String::as_str).unwrap_or("");
    match constraint.constraint_type {
        ConstraintType::Horizontal => if let Some(segment) = segments.get(id(0)) { align_axis(positions, pinned, &segment.start_node_id, &segment.end_node_id, false, weight); },
        ConstraintType::Vertical => if let Some(segment) = segments.get(id(0)) { align_axis(positions, pinned, &segment.start_node_id, &segment.end_node_id, true, weight); },
        ConstraintType::FixedDistance => project_distance(positions, pinned, id(0), id(1), param(constraint, "distance", 0.0), weight),
        ConstraintType::Coincident => project_distance(positions, pinned, id(0), id(1), 0.0, weight),
        ConstraintType::Parallel => align_segments(positions, segments, pinned, id(0), id(1), 0.0, weight),
        ConstraintType::Perpendicular => align_segments(positions, segments, pinned, id(0), id(1), std::f64::consts::FRAC_PI_2, weight),
        ConstraintType::FixedAngle => align_segments(positions, segments, pinned, id(0), id(1), param(constraint, "angle", 90.0).to_radians(), weight),
        ConstraintType::EqualLength => equal_length(positions, segments, pinned, id(0), id(1), weight),
        ConstraintType::Symmetric => project_symmetry(positions, pinned, constraint, weight),
        ConstraintType::Tangent => project_tangent(positions, segments, pinned, constraint, weight),
        ConstraintType::FixedRadius => if let Some(segment) = segments.get_mut(id(0)) {
            project_arc_radius(positions, pinned, segment, param(constraint, "radius", 0.0).max(0.0), weight);
        },
    }
}

fn residual(positions: &BTreeMap<String, Point>, segments: &BTreeMap<String, SegmentInput>, constraint: &ConstraintInput) -> f64 {
    let id = |index: usize| constraint.target_ids.get(index).map(String::as_str).unwrap_or("");
    match constraint.constraint_type {
        ConstraintType::Horizontal => segment_points(positions, segments, id(0)).map(|(a,b)| (b.y-a.y).abs()).unwrap_or(f64::MAX),
        ConstraintType::Vertical => segment_points(positions, segments, id(0)).map(|(a,b)| (b.x-a.x).abs()).unwrap_or(f64::MAX),
        ConstraintType::FixedDistance => pair(positions,id(0),id(1)).map(|(a,b)| (distance(a,b)-param(constraint,"distance",0.0)).abs()).unwrap_or(f64::MAX),
        ConstraintType::Coincident => pair(positions,id(0),id(1)).map(|(a,b)| distance(a,b)).unwrap_or(f64::MAX),
        ConstraintType::Parallel => segment_vectors(positions,segments,id(0),id(1)).map(|(a,b)| cross(normalize(a),normalize(b)).abs()).unwrap_or(f64::MAX),
        ConstraintType::Tangent => tangent_error(positions, segments, constraint),
        ConstraintType::Perpendicular => segment_vectors(positions,segments,id(0),id(1)).map(|(a,b)| dot(normalize(a),normalize(b)).abs()).unwrap_or(f64::MAX),
        ConstraintType::EqualLength => segment_vectors(positions,segments,id(0),id(1)).map(|(a,b)| (magnitude(a)-magnitude(b)).abs()).unwrap_or(f64::MAX),
        ConstraintType::FixedAngle => segment_vectors(positions,segments,id(0),id(1)).map(|(a,b)| normalize_angle(signed_angle(a,b)-param(constraint,"angle",90.0).to_radians()).abs()).unwrap_or(f64::MAX),
        ConstraintType::Symmetric => symmetry_error(positions,constraint),
        ConstraintType::FixedRadius => arc_radius_error(positions, segments.get(id(0)), param(constraint,"radius",0.0).max(0.0)),
    }
}

fn align_axis(positions: &mut BTreeMap<String, Point>, pinned: &BTreeSet<String>, a_id: &str, b_id: &str, x_axis: bool, weight: f64) {
    let Some((a,b)) = pair(positions,a_id,b_id) else { return };
    if pinned.contains(a_id) && pinned.contains(b_id) { return; }
    let value = if x_axis { if pinned.contains(a_id) {a.x} else if pinned.contains(b_id) {b.x} else {(a.x+b.x)/2.0} }
                else { if pinned.contains(a_id) {a.y} else if pinned.contains(b_id) {b.y} else {(a.y+b.y)/2.0} };
    if !pinned.contains(a_id) { let desired = if x_axis {Point{x:value,y:a.y}} else {Point{x:a.x,y:value}}; set_point(positions,a_id,desired,weight); }
    if !pinned.contains(b_id) { let desired = if x_axis {Point{x:value,y:b.y}} else {Point{x:b.x,y:value}}; set_point(positions,b_id,desired,weight); }
}

fn project_distance(positions: &mut BTreeMap<String, Point>, pinned: &BTreeSet<String>, a_id: &str, b_id: &str, target: f64, weight: f64) {
    let Some((a,b)) = pair(positions,a_id,b_id) else { return };
    if pinned.contains(a_id) && pinned.contains(b_id) { return; }
    let mut direction = normalize(sub(b,a)); if magnitude(direction)<1e-12 {direction=Point{x:1.0,y:0.0};}
    let target=target.max(0.0);
    if pinned.contains(a_id) { set_point(positions,b_id,add(a,scale(direction,target)),weight); }
    else if pinned.contains(b_id) { set_point(positions,a_id,sub(b,scale(direction,target)),weight); }
    else { let mid=scale(add(a,b),0.5); let half=scale(direction,target/2.0); set_point(positions,a_id,sub(mid,half),weight); set_point(positions,b_id,add(mid,half),weight); }
}

fn project_arc_radius(
    positions: &mut BTreeMap<String, Point>,
    pinned: &BTreeSet<String>,
    segment: &mut SegmentInput,
    target: f64,
    weight: f64,
) {
    if segment.segment_type != "arc" { return; }
    let (Some(mut center), Some(current_radius), Some(start_angle), Some(end_angle)) =
        (segment.center, segment.radius, segment.start_angle, segment.end_angle) else { return; };
    let radius = (current_radius + (target - current_radius) * weight).max(1e-9);
    let start_direction = Point { x: start_angle.cos(), y: start_angle.sin() };
    let end_direction = Point { x: end_angle.cos(), y: end_angle.sin() };
    let start_pinned = pinned.contains(&segment.start_node_id);
    let end_pinned = pinned.contains(&segment.end_node_id);
    if start_pinned {
        if let Some(start) = positions.get(&segment.start_node_id).copied() {
            center = sub(start, scale(start_direction, radius));
        }
    } else if end_pinned {
        if let Some(end) = positions.get(&segment.end_node_id).copied() {
            center = sub(end, scale(end_direction, radius));
        }
    }
    if !start_pinned {
        set_point(positions, &segment.start_node_id, add(center, scale(start_direction, radius)), weight);
    }
    if !end_pinned {
        set_point(positions, &segment.end_node_id, add(center, scale(end_direction, radius)), weight);
    }
    segment.center = Some(center);
    segment.radius = Some(radius);
}

fn arc_radius_error(
    positions: &BTreeMap<String, Point>,
    segment: Option<&SegmentInput>,
    target: f64,
) -> f64 {
    let Some(segment) = segment else { return f64::MAX; };
    if segment.segment_type != "arc" { return f64::MAX; }
    let (Some(center), Some(radius), Some(start_angle), Some(end_angle)) =
        (segment.center, segment.radius, segment.start_angle, segment.end_angle) else { return f64::MAX; };
    let Some((start, end)) = pair(positions, &segment.start_node_id, &segment.end_node_id) else { return f64::MAX; };
    let desired_start = add(center, scale(Point { x: start_angle.cos(), y: start_angle.sin() }, radius));
    let desired_end = add(center, scale(Point { x: end_angle.cos(), y: end_angle.sin() }, radius));
    (radius - target).abs().max(distance(start, desired_start)).max(distance(end, desired_end))
}

fn project_tangent(
    positions: &mut BTreeMap<String, Point>,
    segments: &BTreeMap<String, SegmentInput>,
    pinned: &BTreeSet<String>,
    constraint: &ConstraintInput,
    weight: f64,
) {
    let (Some(line_id), Some(curve_id), Some(node_id)) =
        (constraint.target_ids.get(0), constraint.target_ids.get(1), constraint.target_ids.get(2)) else { return; };
    let (Some(line), Some(curve)) = (segments.get(line_id), segments.get(curve_id)) else { return; };
    let Some(mut tangent) = tangent_at_node(positions, curve, node_id) else { return; };
    if dot(tangent, segment_unit(positions, line)) < 0.0 { tangent = scale(tangent, -1.0); }
    let mut tangent_pinned = pinned.clone();
    tangent_pinned.insert(node_id.clone());
    place_segment(positions, &tangent_pinned, line, tangent, segment_length(positions, line), weight);
}

fn tangent_error(
    positions: &BTreeMap<String, Point>,
    segments: &BTreeMap<String, SegmentInput>,
    constraint: &ConstraintInput,
) -> f64 {
    let (Some(line_id), Some(curve_id), Some(node_id)) =
        (constraint.target_ids.get(0), constraint.target_ids.get(1), constraint.target_ids.get(2)) else { return f64::MAX; };
    let (Some(line), Some(curve)) = (segments.get(line_id), segments.get(curve_id)) else { return f64::MAX; };
    tangent_at_node(positions, curve, node_id)
        .map(|tangent| cross(segment_unit(positions, line), tangent).abs())
        .unwrap_or(f64::MAX)
}

fn tangent_at_node(
    positions: &BTreeMap<String, Point>,
    segment: &SegmentInput,
    node_id: &str,
) -> Option<Point> {
    if segment.segment_type == "arc" {
        let center = segment.center?;
        let endpoint = positions.get(node_id).copied()?;
        let radial = normalize(sub(endpoint, center));
        if magnitude(radial) < 1e-12 { return None; }
        let direction = if segment.clockwise.unwrap_or(false) { -1.0 } else { 1.0 };
        return Some(scale(Point { x: -radial.y, y: radial.x }, direction));
    }
    Some(segment_unit(positions, segment))
}

fn align_segments(positions: &mut BTreeMap<String, Point>, segments: &BTreeMap<String, SegmentInput>, pinned: &BTreeSet<String>, first_id: &str, second_id: &str, angle: f64, weight: f64) {
    let (Some(first),Some(second))=(segments.get(first_id),segments.get(second_id)) else{return};
    let first_p=segment_pinned(first,pinned); let second_p=segment_pinned(second,pinned);
    let (reference,follower)=if second_p&&!first_p {(second,first)} else {(first,second)};
    let mut direction=rotate(segment_unit(positions,reference),angle); let current=segment_unit(positions,follower);
    if dot(direction,current)<0.0 {direction=scale(direction,-1.0);}
    place_segment(positions,pinned,follower,direction,segment_length(positions,follower),weight);
}

fn equal_length(positions: &mut BTreeMap<String, Point>, segments: &BTreeMap<String, SegmentInput>, pinned: &BTreeSet<String>, first_id: &str, second_id: &str, weight: f64) {
    let (Some(first),Some(second))=(segments.get(first_id),segments.get(second_id)) else{return};
    let (reference,follower)=if segment_pinned(second,pinned)&&!segment_pinned(first,pinned) {(second,first)} else {(first,second)};
    place_segment(positions,pinned,follower,segment_unit(positions,follower),segment_length(positions,reference),weight);
}

fn place_segment(positions:&mut BTreeMap<String,Point>,pinned:&BTreeSet<String>,segment:&SegmentInput,direction:Point,length:f64,weight:f64){
    let Some((a,b))=pair(positions,&segment.start_node_id,&segment.end_node_id)else{return};
    if pinned.contains(&segment.start_node_id)&&pinned.contains(&segment.end_node_id){return}
    if pinned.contains(&segment.start_node_id){set_point(positions,&segment.end_node_id,add(a,scale(direction,length)),weight)}
    else if pinned.contains(&segment.end_node_id){set_point(positions,&segment.start_node_id,sub(b,scale(direction,length)),weight)}
    else{let mid=scale(add(a,b),0.5);let half=scale(direction,length/2.0);set_point(positions,&segment.start_node_id,sub(mid,half),weight);set_point(positions,&segment.end_node_id,add(mid,half),weight)}
}

fn project_symmetry(positions:&mut BTreeMap<String,Point>,pinned:&BTreeSet<String>,constraint:&ConstraintInput,weight:f64){
    let Some(a_id)=constraint.target_ids.get(0)else{return};let Some(b_id)=constraint.target_ids.get(1)else{return};
    let Some((a,b))=pair(positions,a_id,b_id)else{return};let (axis_a,axis_b)=axis(positions,constraint);
    if pinned.contains(a_id)&&pinned.contains(b_id){return}
    if pinned.contains(a_id){set_point(positions,b_id,reflect(a,axis_a,axis_b),weight)}
    else if pinned.contains(b_id){set_point(positions,a_id,reflect(b,axis_a,axis_b),weight)}
    else{let projected=scale(add(a,reflect(b,axis_a,axis_b)),0.5);set_point(positions,a_id,projected,weight);set_point(positions,b_id,reflect(projected,axis_a,axis_b),weight)}
}
fn symmetry_error(positions:&BTreeMap<String,Point>,constraint:&ConstraintInput)->f64{let Some(a_id)=constraint.target_ids.get(0)else{return f64::MAX};let Some(b_id)=constraint.target_ids.get(1)else{return f64::MAX};let Some((a,b))=pair(positions,a_id,b_id)else{return f64::MAX};let(axis_a,axis_b)=axis(positions,constraint);distance(reflect(a,axis_a,axis_b),b)}
fn axis(positions:&BTreeMap<String,Point>,constraint:&ConstraintInput)->(Point,Point){if let(Some(a),Some(b))=(constraint.target_ids.get(2),constraint.target_ids.get(3)){if let Some(pair)=pair(positions,a,b){return pair}}let x=param(constraint,"axisX",0.0);let y=param(constraint,"axisY",0.0);let angle=param(constraint,"axisAngle",90.0).to_radians();(Point{x,y},Point{x:x+angle.cos(),y:y+angle.sin()})}

fn structural_conflicts(positions:&BTreeMap<String,Point>,segments:&BTreeMap<String,SegmentInput>,constraints:&[ConstraintInput])->Vec<ConflictOutput>{
    let hard:Vec<_>=constraints.iter().filter(|c|c.priority==Priority::Hard).collect();let mut out=vec![];
    for c in &hard{let missing:Vec<_>=c.target_ids.iter().filter(|id|!positions.contains_key(*id)&&!segments.contains_key(*id)).collect();if !missing.is_empty(){out.push(ConflictOutput{constraint_ids:vec![c.id.clone()],message:format!("{} references missing geometry.",label(&c.constraint_type)),error:f64::MAX,suggestion:"Drop the constraint or undo the topology edit.".into()})}}
    for i in 0..hard.len(){for j in i+1..hard.len(){let(a,b)=(hard[i],hard[j]);let same={let mut x=a.target_ids.clone();let mut y=b.target_ids.clone();x.sort();y.sort();x==y};
        if same&&matches!(a.constraint_type,ConstraintType::FixedDistance)&&matches!(b.constraint_type,ConstraintType::FixedDistance){let error=(param(a,"distance",0.0)-param(b,"distance",0.0)).abs();if error>a.tolerance.max(b.tolerance).max(DEFAULT_TOLERANCE){out.push(pair_conflict(a,b,error,"Two hard fixed-distance constraints request different dimensions."))}}
        if same&&matches!(a.constraint_type,ConstraintType::FixedAngle)&&matches!(b.constraint_type,ConstraintType::FixedAngle){let error=normalize_angle((param(a,"angle",0.0)-param(b,"angle",0.0)).to_radians()).abs();if error>a.tolerance.max(b.tolerance).max(DEFAULT_TOLERANCE){out.push(pair_conflict(a,b,error,"Two hard angle constraints request different angles."))}}
        if same&&matches!(a.constraint_type,ConstraintType::FixedRadius)&&matches!(b.constraint_type,ConstraintType::FixedRadius){let error=(param(a,"radius",0.0)-param(b,"radius",0.0)).abs();if error>a.tolerance.max(b.tolerance).max(DEFAULT_TOLERANCE){out.push(pair_conflict(a,b,error,"Two hard radius constraints request different arc radii."))}}
        if a.target_ids.get(0)==b.target_ids.get(0)&&((matches!(a.constraint_type,ConstraintType::Horizontal)&&matches!(b.constraint_type,ConstraintType::Vertical))||(matches!(a.constraint_type,ConstraintType::Vertical)&&matches!(b.constraint_type,ConstraintType::Horizontal))){out.push(pair_conflict(a,b,1.0,"A segment cannot be both horizontal and vertical."))}
    }}out
}
fn pair_conflict(a:&ConstraintInput,b:&ConstraintInput,error:f64,message:&str)->ConflictOutput{ConflictOutput{constraint_ids:vec![a.id.clone(),b.id.clone()],message:message.into(),error,suggestion:format!("Drop {} or relax it to soft.",short_id(&b.id))}}

fn segment_points(positions:&BTreeMap<String,Point>,segments:&BTreeMap<String,SegmentInput>,id:&str)->Option<(Point,Point)>{let s=segments.get(id)?;pair(positions,&s.start_node_id,&s.end_node_id)}
fn segment_vectors(positions:&BTreeMap<String,Point>,segments:&BTreeMap<String,SegmentInput>,a:&str,b:&str)->Option<(Point,Point)>{let(ap,ae)=segment_points(positions,segments,a)?;let(bp,be)=segment_points(positions,segments,b)?;Some((sub(ae,ap),sub(be,bp)))}
fn segment_unit(p:&BTreeMap<String,Point>,s:&SegmentInput)->Point{segment_points(p,&BTreeMap::from([(s.id.clone(),s.clone())]),&s.id).map(|(a,b)|normalize(sub(b,a))).unwrap_or(Point{x:1.0,y:0.0})}
fn segment_length(p:&BTreeMap<String,Point>,s:&SegmentInput)->f64{pair(p,&s.start_node_id,&s.end_node_id).map(|(a,b)|distance(a,b)).unwrap_or(0.0)}
fn segment_pinned(s:&SegmentInput,p:&BTreeSet<String>)->bool{p.contains(&s.start_node_id)||p.contains(&s.end_node_id)}
fn pair(p:&BTreeMap<String,Point>,a:&str,b:&str)->Option<(Point,Point)>{Some((*p.get(a)?,*p.get(b)?))}
fn set_point(p:&mut BTreeMap<String,Point>,id:&str,target:Point,w:f64){if let Some(c)=p.get(id).copied(){p.insert(id.to_string(),Point{x:c.x+(target.x-c.x)*w,y:c.y+(target.y-c.y)*w});}}
fn reflect(v:Point,a:Point,b:Point)->Point{let axis=normalize(sub(b,a));if magnitude(axis)<1e-12{return v}let rel=sub(v,a);let proj=scale(axis,dot(rel,axis));add(a,sub(scale(proj,2.0),rel))}
fn param(c:&ConstraintInput,key:&str,fallback:f64)->f64{c.parameters.get(key).copied().unwrap_or(fallback)}
fn priority_rank(p:&Priority)->u8{match p{Priority::Hard=>0,Priority::Medium=>1,Priority::Soft=>2}}
fn priority_weight(p:&Priority)->f64{match p{Priority::Hard=>1.0,Priority::Medium=>0.55,Priority::Soft=>0.25}}
fn label(t:&ConstraintType)->&'static str{match t{ConstraintType::Parallel=>"Parallel",ConstraintType::Perpendicular=>"Perpendicular",ConstraintType::Tangent=>"Tangent",ConstraintType::Symmetric=>"Symmetric",ConstraintType::EqualLength=>"Equal length",ConstraintType::FixedDistance=>"Fixed distance",ConstraintType::FixedAngle=>"Fixed angle",ConstraintType::FixedRadius=>"Fixed radius",ConstraintType::Horizontal=>"Horizontal",ConstraintType::Vertical=>"Vertical",ConstraintType::Coincident=>"Coincident"}}
fn short_id(id:&str)->String{id.chars().rev().take(6).collect::<String>().chars().rev().collect()}
fn add(a:Point,b:Point)->Point{Point{x:a.x+b.x,y:a.y+b.y}}fn sub(a:Point,b:Point)->Point{Point{x:a.x-b.x,y:a.y-b.y}}fn scale(a:Point,s:f64)->Point{Point{x:a.x*s,y:a.y*s}}fn magnitude(a:Point)->f64{a.x.hypot(a.y)}fn normalize(a:Point)->Point{let m=magnitude(a);if m>1e-12{scale(a,1.0/m)}else{Point{x:0.0,y:0.0}}}fn distance(a:Point,b:Point)->f64{magnitude(sub(a,b))}fn dot(a:Point,b:Point)->f64{a.x*b.x+a.y*b.y}fn cross(a:Point,b:Point)->f64{a.x*b.y-a.y*b.x}fn rotate(a:Point,r:f64)->Point{Point{x:a.x*r.cos()-a.y*r.sin(),y:a.x*r.sin()+a.y*r.cos()}}fn signed_angle(a:Point,b:Point)->f64{cross(a,b).atan2(dot(a,b))}fn normalize_angle(mut a:f64)->f64{while a>std::f64::consts::PI{a-=2.0*std::f64::consts::PI}while a< -std::f64::consts::PI{a+=2.0*std::f64::consts::PI}a}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_radius_updates_native_arc_geometry_and_endpoints() {
        let input: SolveInput = serde_json::from_str(r#"{
            "nodes":[{"id":"a","x":10.0,"y":0.0},{"id":"b","x":0.0,"y":10.0}],
            "segments":[{
                "id":"arc","startNodeId":"a","endNodeId":"b","segmentType":"arc",
                "center":{"x":0.0,"y":0.0},"radius":10.0,
                "startAngle":0.0,"endAngle":1.5707963267948966,"clockwise":false
            }],
            "constraints":[{
                "id":"radius","type":"fixed_radius","priority":"hard","targetIds":["arc"],
                "parameters":{"radius":20.0},"tolerance":0.000001
            }],
            "pinnedNodeIds":[],"tolerance":0.000001,"maxIterations":100
        }"#).unwrap();
        let result = solve(input);
        assert!(result.success, "native arc solve failed");
        assert_eq!(result.adjusted_segments.len(), 1);
        assert!((result.adjusted_segments[0].radius - 20.0).abs() < 1e-9);
        let a = result.adjusted_nodes.iter().find(|node| node.id == "a").unwrap();
        let b = result.adjusted_nodes.iter().find(|node| node.id == "b").unwrap();
        assert!((a.x - 20.0).abs() < 1e-9 && a.y.abs() < 1e-9);
        assert!(b.x.abs() < 1e-9 && (b.y - 20.0).abs() < 1e-9);
    }

    #[test]
    fn fixed_radius_rejects_non_arc_proxy_geometry() {
        let input: SolveInput = serde_json::from_str(r#"{
            "nodes":[{"id":"a","x":0.0,"y":0.0},{"id":"b","x":40.0,"y":0.0}],
            "segments":[{"id":"line","startNodeId":"a","endNodeId":"b","segmentType":"line"}],
            "constraints":[{
                "id":"radius","type":"fixed_radius","priority":"hard","targetIds":["line"],
                "parameters":{"radius":20.0},"tolerance":0.000001
            }],
            "pinnedNodeIds":[],"tolerance":0.000001,"maxIterations":4
        }"#).unwrap();
        let result = solve(input);
        assert!(!result.success);
        assert!(result.adjusted_segments.is_empty());
    }
}
