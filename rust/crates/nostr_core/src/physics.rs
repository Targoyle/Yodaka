use serde::{Deserialize, Serialize};

const GRAVITY_PX_PER_SEC2: f32 = 2200.0;
const LINEAR_DAMPING: f32 = 0.996;
const ANGULAR_DAMPING: f32 = 0.992;
const ROTATION_ENABLED: bool = false;
const FLOOR_RESTITUTION: f32 = 0.0;
const BODY_RESTITUTION: f32 = 0.0;
const MAX_STEP_SEC: f32 = 1.0 / 30.0;
const DRAG_LERP: f32 = 0.45;
const DRAG_VELOCITY_GAIN: f32 = 20.0;
const FLOOR_MARGIN_PX: f32 = 2.0;
const BODY_COLLIDER_INSET_PX: f32 = 0.0;
const CONSTRAINT_SOLVER_ITERATIONS: usize = 10;
const MIN_COLLIDER_HALF_EXTENT_PX: f32 = 0.5;
const FLOOR_REST_VELOCITY_EPS: f32 = 48.0;
const BODY_REST_VELOCITY_EPS: f32 = 24.0;

#[derive(Clone, Debug, Deserialize)]
pub struct PhysicsBodySeed {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub angle: f32,
}

#[derive(Clone, Debug, Serialize)]
pub struct PhysicsBodySnapshot {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub angle: f32,
}

#[derive(Clone, Debug)]
struct PhysicsBody {
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    angle: f32,
    vx: f32,
    vy: f32,
    angular_velocity: f32,
}

#[derive(Clone, Debug)]
struct DragState {
    index: usize,
    pointer_x: f32,
    pointer_y: f32,
    offset_x: f32,
    offset_y: f32,
    velocity_x: f32,
    velocity_y: f32,
}

#[derive(Clone, Copy, Debug, Default)]
struct Vec2 {
    x: f32,
    y: f32,
}

impl Vec2 {
    const fn new(x: f32, y: f32) -> Self {
        Self { x, y }
    }

    fn dot(self, other: Self) -> f32 {
        self.x * other.x + self.y * other.y
    }

    fn scale(self, value: f32) -> Self {
        Self::new(self.x * value, self.y * value)
    }
}

#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Copy, Debug)]
struct Aabb {
    min_x: f32,
    min_y: f32,
    max_x: f32,
    max_y: f32,
}

#[derive(Clone, Copy, Debug)]
struct OrientedRect {
    center: Vec2,
    half_extents: Vec2,
    axis_x: Vec2,
    axis_y: Vec2,
}

impl OrientedRect {
    fn from_body(body: &PhysicsBody, inset_px: f32) -> Self {
        let half_width = (body.width / 2.0 - inset_px).max(MIN_COLLIDER_HALF_EXTENT_PX);
        let half_height = (body.height / 2.0 - inset_px).max(MIN_COLLIDER_HALF_EXTENT_PX);
        let (sin_angle, cos_angle) = body.angle.sin_cos();

        Self {
            center: Vec2::new(body.x + body.width / 2.0, body.y + body.height / 2.0),
            half_extents: Vec2::new(half_width, half_height),
            axis_x: Vec2::new(cos_angle, sin_angle),
            axis_y: Vec2::new(-sin_angle, cos_angle),
        }
    }

    fn project_radius(self, axis: Vec2) -> f32 {
        self.half_extents.x * self.axis_x.dot(axis).abs()
            + self.half_extents.y * self.axis_y.dot(axis).abs()
    }

    fn aabb(self) -> Aabb {
        let extent_x =
            self.axis_x.x.abs() * self.half_extents.x + self.axis_y.x.abs() * self.half_extents.y;
        let extent_y =
            self.axis_x.y.abs() * self.half_extents.x + self.axis_y.y.abs() * self.half_extents.y;

        Aabb {
            min_x: self.center.x - extent_x,
            max_x: self.center.x + extent_x,
            min_y: self.center.y - extent_y,
            max_y: self.center.y + extent_y,
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct CollisionManifold {
    normal: Vec2,
    penetration: f32,
}

#[derive(Default)]
pub struct PhysicsWorld {
    width: f32,
    height: f32,
    bodies: Vec<PhysicsBody>,
    drag: Option<DragState>,
}

impl PhysicsWorld {
    pub fn new(width: f32, height: f32) -> Self {
        Self {
            width: width.max(0.0),
            height: height.max(0.0),
            bodies: Vec::new(),
            drag: None,
        }
    }

    pub fn set_bounds(&mut self, width: f32, height: f32) {
        self.width = width.max(0.0);
        self.height = height.max(0.0);
    }

    pub fn set_bodies(&mut self, seeds: Vec<PhysicsBodySeed>) {
        self.bodies = seeds
            .into_iter()
            .map(|seed| PhysicsBody {
                x: seed.x,
                y: seed.y,
                width: seed.width.max(1.0),
                height: seed.height.max(1.0),
                angle: seed.angle,
                vx: 0.0,
                vy: 0.0,
                angular_velocity: 0.0,
            })
            .collect();
        self.drag = None;
    }

    pub fn step(&mut self, dt_ms: f32) -> Vec<PhysicsBodySnapshot> {
        let dt = (dt_ms / 1000.0).clamp(0.0, MAX_STEP_SEC);

        for index in 0..self.bodies.len() {
            if self.drag.as_ref().is_some_and(|drag| drag.index == index) {
                self.step_dragged_body(index, dt);
            } else if dt > 0.0 {
                self.step_free_body(index, dt);
            }

            self.resolve_world_bounds(index);
        }

        for _ in 0..CONSTRAINT_SOLVER_ITERATIONS {
            self.resolve_body_collisions();

            for index in 0..self.bodies.len() {
                self.resolve_world_bounds(index);
            }
        }

        self.snapshots()
    }

    pub fn pointer_down(&mut self, index: usize, pointer_x: f32, pointer_y: f32) -> bool {
        let Some(body) = self.bodies.get(index) else {
            return false;
        };

        self.drag = Some(DragState {
            index,
            pointer_x,
            pointer_y,
            offset_x: pointer_x - body.x,
            offset_y: pointer_y - body.y,
            velocity_x: 0.0,
            velocity_y: 0.0,
        });
        true
    }

    pub fn pointer_move(&mut self, pointer_x: f32, pointer_y: f32) {
        let Some(drag) = self.drag.as_mut() else {
            return;
        };

        drag.velocity_x = pointer_x - drag.pointer_x;
        drag.velocity_y = pointer_y - drag.pointer_y;
        drag.pointer_x = pointer_x;
        drag.pointer_y = pointer_y;
    }

    pub fn pointer_up(&mut self) {
        let Some(drag) = self.drag.take() else {
            return;
        };

        if let Some(body) = self.bodies.get_mut(drag.index) {
            body.vx += drag.velocity_x * DRAG_VELOCITY_GAIN;
            body.vy += drag.velocity_y * DRAG_VELOCITY_GAIN;

            if !ROTATION_ENABLED {
                body.angle = 0.0;
                body.angular_velocity = 0.0;
            } else {
                body.angular_velocity += drag.velocity_x * 0.06;
            }
        }
    }

    pub fn snapshots(&self) -> Vec<PhysicsBodySnapshot> {
        self.bodies
            .iter()
            .map(|body| PhysicsBodySnapshot {
                x: body.x,
                y: body.y,
                width: body.width,
                height: body.height,
                angle: body.angle,
            })
            .collect()
    }

    fn step_free_body(&mut self, index: usize, dt: f32) {
        let body = &mut self.bodies[index];
        body.vy += GRAVITY_PX_PER_SEC2 * dt;
        body.x += body.vx * dt;
        body.y += body.vy * dt;
        body.vx *= LINEAR_DAMPING;
        body.vy *= LINEAR_DAMPING;

        if !ROTATION_ENABLED {
            body.angle = 0.0;
            body.angular_velocity = 0.0;
        } else {
            body.angle += body.angular_velocity * dt;
            body.angular_velocity *= ANGULAR_DAMPING;
        }
    }

    fn step_dragged_body(&mut self, index: usize, dt: f32) {
        let Some(drag) = self.drag.as_ref() else {
            return;
        };

        let body = &mut self.bodies[index];
        let target_x = drag.pointer_x - drag.offset_x;
        let target_y = drag.pointer_y - drag.offset_y;
        let delta_x = target_x - body.x;
        let delta_y = target_y - body.y;

        body.x += delta_x * DRAG_LERP;
        body.y += delta_y * DRAG_LERP;
        body.vx = (delta_x / dt.max(0.001)) * 0.12;
        body.vy = (delta_y / dt.max(0.001)) * 0.12;

        if !ROTATION_ENABLED {
            body.angle = 0.0;
            body.angular_velocity = 0.0;
        } else {
            body.angular_velocity = drag.velocity_x * 0.08;
            body.angle += body.angular_velocity * dt;
        }
    }

    fn resolve_world_bounds(&mut self, index: usize) {
        let body = &mut self.bodies[index];
        let floor_y = (self.height - FLOOR_MARGIN_PX).max(0.0);
        let aabb = visual_rect(body).aabb();

        if aabb.max_y > floor_y {
            body.y -= aabb.max_y - floor_y;

            if body.vy > 0.0 {
                body.vy = -body.vy * FLOOR_RESTITUTION;
            }

            body.vx *= 0.94;
            clamp_velocity(body, FLOOR_REST_VELOCITY_EPS);

            if !ROTATION_ENABLED {
                body.angle = 0.0;
                body.angular_velocity = 0.0;
            } else {
                body.angular_velocity *= 0.9;
            }
        }
    }

    fn resolve_body_collisions(&mut self) {
        let len = self.bodies.len();

        for left_index in 0..len {
            for right_index in (left_index + 1)..len {
                let left_dragged = self
                    .drag
                    .as_ref()
                    .is_some_and(|drag| drag.index == left_index);
                let right_dragged = self
                    .drag
                    .as_ref()
                    .is_some_and(|drag| drag.index == right_index);
                let Some((left, right)) = self.split_pair(left_index, right_index) else {
                    continue;
                };

                let Some(collision) = compute_body_collision(left, right) else {
                    continue;
                };
                let correction = collision.normal.scale(collision.penetration);

                match (left_dragged, right_dragged) {
                    (false, false) => {
                        translate_body(left, correction.scale(-0.5));
                        translate_body(right, correction.scale(0.5));
                    }
                    (true, false) => {
                        translate_body(right, correction);
                    }
                    (false, true) => {
                        translate_body(left, correction.scale(-1.0));
                    }
                    (true, true) => continue,
                }

                if !left_dragged {
                    reflect_velocity(left, collision.normal.scale(-1.0));
                    clamp_velocity(left, BODY_REST_VELOCITY_EPS);
                }

                if !right_dragged {
                    reflect_velocity(right, collision.normal);
                    clamp_velocity(right, BODY_REST_VELOCITY_EPS);
                }
            }
        }
    }

    fn split_pair(
        &mut self,
        left_index: usize,
        right_index: usize,
    ) -> Option<(&mut PhysicsBody, &mut PhysicsBody)> {
        if left_index == right_index
            || left_index >= self.bodies.len()
            || right_index >= self.bodies.len()
        {
            return None;
        }

        let (head, tail) = self.bodies.split_at_mut(right_index);
        Some((&mut head[left_index], &mut tail[0]))
    }
}

fn compute_body_collision(left: &PhysicsBody, right: &PhysicsBody) -> Option<CollisionManifold> {
    let left_rect = collision_rect(left);
    let right_rect = collision_rect(right);
    let center_delta = Vec2::new(
        right_rect.center.x - left_rect.center.x,
        right_rect.center.y - left_rect.center.y,
    );
    let axes = [
        left_rect.axis_x,
        left_rect.axis_y,
        right_rect.axis_x,
        right_rect.axis_y,
    ];
    let mut best_normal = left_rect.axis_x;
    let mut best_penetration = f32::INFINITY;

    for axis in axes {
        let distance = center_delta.dot(axis);
        let overlap =
            left_rect.project_radius(axis) + right_rect.project_radius(axis) - distance.abs();

        if overlap <= 0.0 {
            return None;
        }

        if overlap < best_penetration {
            best_penetration = overlap;
            best_normal = if distance < 0.0 {
                axis.scale(-1.0)
            } else {
                axis
            };
        }
    }

    Some(CollisionManifold {
        normal: best_normal,
        penetration: best_penetration,
    })
}

fn collision_rect(body: &PhysicsBody) -> OrientedRect {
    OrientedRect::from_body(body, BODY_COLLIDER_INSET_PX)
}

fn visual_rect(body: &PhysicsBody) -> OrientedRect {
    OrientedRect::from_body(body, 0.0)
}

fn translate_body(body: &mut PhysicsBody, delta: Vec2) {
    body.x += delta.x;
    body.y += delta.y;
}

fn reflect_velocity(body: &mut PhysicsBody, outward_normal: Vec2) {
    let velocity_along_normal = body.vx * outward_normal.x + body.vy * outward_normal.y;

    if velocity_along_normal >= 0.0 {
        return;
    }

    let impulse_scale = velocity_along_normal * (1.0 + BODY_RESTITUTION);
    body.vx -= outward_normal.x * impulse_scale;
    body.vy -= outward_normal.y * impulse_scale;
}

fn clamp_velocity(body: &mut PhysicsBody, epsilon: f32) {
    if body.vx.abs() < epsilon {
        body.vx = 0.0;
    }

    if body.vy.abs() < epsilon {
        body.vy = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use core::f32::consts::FRAC_PI_4;

    use super::{
        FLOOR_MARGIN_PX, PhysicsBody, PhysicsBodySeed, PhysicsWorld, compute_body_collision,
        visual_rect,
    };

    fn build_body(x: f32, y: f32, width: f32, height: f32, angle: f32) -> PhysicsBody {
        PhysicsBody {
            x,
            y,
            width,
            height,
            angle,
            vx: 0.0,
            vy: 0.0,
            angular_velocity: 0.0,
        }
    }

    #[test]
    fn gravity_moves_body_downward() {
        let mut world = PhysicsWorld::new(400.0, 800.0);
        world.set_bodies(vec![PhysicsBodySeed {
            x: 10.0,
            y: 10.0,
            width: 100.0,
            height: 40.0,
            angle: 0.0,
        }]);

        let before = world.snapshots()[0].y;
        let after = world.step(16.0)[0].y;

        assert!(after > before);
    }

    #[test]
    fn zero_dt_step_moves_dragged_body() {
        let mut world = PhysicsWorld::new(400.0, 400.0);
        world.set_bodies(vec![PhysicsBodySeed {
            x: 24.0,
            y: 40.0,
            width: 120.0,
            height: 96.0,
            angle: 0.0,
        }]);
        let before = world.snapshots()[0].x;

        assert!(world.pointer_down(0, 40.0, 56.0));
        world.pointer_move(180.0, 160.0);

        let after = world.step(0.0)[0].x;

        assert!(after > before);
    }

    #[test]
    fn rotated_rectangles_do_not_collide_when_only_aabbs_overlap() {
        let left = build_body(0.0, 0.0, 100.0, 100.0, FRAC_PI_4);
        let right = build_body(55.0, 120.0, 100.0, 100.0, 0.0);

        assert!(compute_body_collision(&left, &right).is_none());
    }

    #[test]
    fn floor_collision_uses_rotated_visual_bounds() {
        let mut world = PhysicsWorld::new(220.0, 160.0);
        world.set_bodies(vec![PhysicsBodySeed {
            x: 48.0,
            y: 90.0,
            width: 100.0,
            height: 100.0,
            angle: FRAC_PI_4,
        }]);

        world.resolve_world_bounds(0);

        let floor_y = world.height - FLOOR_MARGIN_PX;
        let body = &world.bodies[0];
        let aabb = visual_rect(body).aabb();

        assert!(aabb.max_y <= floor_y + 0.01);
        assert!(aabb.min_x < aabb.max_x);
        assert!(aabb.min_y < aabb.max_y);
    }

    #[test]
    fn stacked_bodies_remain_above_floor_after_many_steps() {
        let mut world = PhysicsWorld::new(360.0, 320.0);
        world.set_bodies(vec![
            PhysicsBodySeed {
                x: 96.0,
                y: -240.0,
                width: 180.0,
                height: 140.0,
                angle: -0.08,
            },
            PhysicsBodySeed {
                x: 104.0,
                y: -420.0,
                width: 180.0,
                height: 160.0,
                angle: 0.05,
            },
            PhysicsBodySeed {
                x: 92.0,
                y: -620.0,
                width: 180.0,
                height: 180.0,
                angle: -0.03,
            },
        ]);

        for _ in 0..240 {
            world.step(16.0);
        }

        let floor_y = world.height - FLOOR_MARGIN_PX;

        for body in &world.bodies {
            let aabb = visual_rect(body).aabb();

            assert!(aabb.max_y <= floor_y + 0.01);
        }
    }

    #[test]
    fn rotation_disabled_keeps_angles_zero_after_step() {
        let mut world = PhysicsWorld::new(320.0, 320.0);
        world.set_bodies(vec![PhysicsBodySeed {
            x: 24.0,
            y: 24.0,
            width: 120.0,
            height: 96.0,
            angle: FRAC_PI_4,
        }]);

        let snapshot = world.step(16.0);

        assert_eq!(snapshot[0].angle, 0.0);
    }
}
