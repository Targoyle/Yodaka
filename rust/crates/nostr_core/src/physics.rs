use serde::{Deserialize, Serialize};

const GRAVITY_PX_PER_SEC2: f32 = 2200.0;
const LINEAR_DAMPING: f32 = 0.996;
const ANGULAR_DAMPING: f32 = 0.992;
const FLOOR_RESTITUTION: f32 = 0.32;
const BODY_RESTITUTION: f32 = 0.18;
const MAX_STEP_SEC: f32 = 1.0 / 30.0;
const DRAG_LERP: f32 = 0.45;
const DRAG_VELOCITY_GAIN: f32 = 20.0;
const FLOOR_MARGIN_PX: f32 = 2.0;
const BODY_COLLISION_SHRINK_RIGHT_PX: f32 = 30.0;
const BODY_COLLISION_SHRINK_BOTTOM_PX: f32 = 34.0;

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

        if dt <= 0.0 {
            return self.snapshots();
        }

        for index in 0..self.bodies.len() {
            if self.drag.as_ref().is_some_and(|drag| drag.index == index) {
                self.step_dragged_body(index, dt);
            } else {
                self.step_free_body(index, dt);
            }

            self.resolve_world_bounds(index);
        }

        self.resolve_body_collisions();

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
            body.angular_velocity += drag.velocity_x * 0.06;
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
        body.angle += body.angular_velocity * dt;
        body.vx *= LINEAR_DAMPING;
        body.vy *= LINEAR_DAMPING;
        body.angular_velocity *= ANGULAR_DAMPING;
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
        body.angular_velocity = drag.velocity_x * 0.08;
        body.angle += body.angular_velocity * dt;
    }

    fn resolve_world_bounds(&mut self, index: usize) {
        let body = &mut self.bodies[index];
        let floor_y = (self.height - FLOOR_MARGIN_PX).max(0.0);
        let effective_height = (body.height - BODY_COLLISION_SHRINK_BOTTOM_PX).max(1.0);

        if body.y + effective_height > floor_y {
            body.y = (floor_y - effective_height).max(0.0);
            body.vy = -body.vy.abs() * FLOOR_RESTITUTION;
            body.vx *= 0.94;
            body.angular_velocity *= 0.9;
        }
    }

    fn resolve_body_collisions(&mut self) {
        let len = self.bodies.len();

        for left_index in 0..len {
            for right_index in (left_index + 1)..len {
                let left_dragged = self.drag.as_ref().is_some_and(|drag| drag.index == left_index);
                let right_dragged = self
                    .drag
                    .as_ref()
                    .is_some_and(|drag| drag.index == right_index);
                let Some((left, right)) = self.split_pair(left_index, right_index) else {
                    continue;
                };

                let left_collision_x = left.x;
                let left_collision_y = left.y;
                let left_collision_width = (left.width - BODY_COLLISION_SHRINK_RIGHT_PX).max(1.0);
                let left_collision_height =
                    (left.height - BODY_COLLISION_SHRINK_BOTTOM_PX).max(1.0);

                let right_collision_x = right.x;
                let right_collision_y = right.y;
                let right_collision_width =
                    (right.width - BODY_COLLISION_SHRINK_RIGHT_PX).max(1.0);
                let right_collision_height =
                    (right.height - BODY_COLLISION_SHRINK_BOTTOM_PX).max(1.0);

                let overlap_x = (left_collision_x + left_collision_width)
                    .min(right_collision_x + right_collision_width)
                    - left_collision_x.max(right_collision_x);
                let overlap_y = (left_collision_y + left_collision_height)
                    .min(right_collision_y + right_collision_height)
                    - left_collision_y.max(right_collision_y);

                if overlap_x <= 0.0 || overlap_y <= 0.0 {
                    continue;
                }

                if overlap_x < overlap_y {
                    let push = overlap_x / 2.0;

                    if !left_dragged {
                        left.x -= push;
                        left.vx = -left.vx * BODY_RESTITUTION;
                    }

                    if !right_dragged {
                        right.x += push;
                        right.vx = -right.vx * BODY_RESTITUTION;
                    }
                } else {
                    let push = overlap_y / 2.0;

                    if !left_dragged {
                        left.y -= push;
                        left.vy = -left.vy * BODY_RESTITUTION;
                    }

                    if !right_dragged {
                        right.y += push;
                        right.vy = -right.vy * BODY_RESTITUTION;
                    }
                }
            }
        }
    }

    fn split_pair(
        &mut self,
        left_index: usize,
        right_index: usize,
    ) -> Option<(&mut PhysicsBody, &mut PhysicsBody)> {
        if left_index == right_index || left_index >= self.bodies.len() || right_index >= self.bodies.len()
        {
            return None;
        }

        let (head, tail) = self.bodies.split_at_mut(right_index);
        Some((&mut head[left_index], &mut tail[0]))
    }
}

#[cfg(test)]
mod tests {
    use super::{PhysicsBodySeed, PhysicsWorld};

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
}
