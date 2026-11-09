use std::collections::HashSet;

type BuildKey = (u64, String);

/// Reservations follow the monotonically increasing SemanticRuntime generation.
/// Replaced jobs may finish later, but cannot release their successor's slot.
pub(crate) struct RelatedScenesBuildRegistry {
    generation: Option<u64>,
    keys: HashSet<BuildKey>,
    /// Reserved keys whose running task was asked (by a later `schedule` that
    /// found the reservation taken) to make its next tick a foreground one.
    /// Always a subset of `keys` of the current generation.
    foreground: HashSet<BuildKey>,
    capacity: usize,
}

impl RelatedScenesBuildRegistry {
    pub(crate) fn new(capacity: usize) -> Self {
        Self {
            generation: None,
            keys: HashSet::new(),
            foreground: HashSet::new(),
            capacity,
        }
    }

    pub(crate) fn reserve(&mut self, key: BuildKey, generation: u64) -> bool {
        match self.generation {
            Some(current) if current > generation => return false,
            Some(current) if current == generation => {}
            _ => {
                // All previous SemanticRequests are revoked by this rotation.
                // They must not consume the new generation's capacity.
                self.keys.clear();
                self.foreground.clear();
                self.generation = Some(generation);
            }
        }
        if self.keys.contains(&key) || self.keys.len() >= self.capacity {
            return false;
        }
        self.keys.insert(key)
    }

    pub(crate) fn release(&mut self, key: &BuildKey, generation: u64) {
        if self.generation == Some(generation) {
            self.keys.remove(key);
            self.foreground.remove(key);
        }
    }

    /// Ask the running task of `key` to take its next tick as a foreground
    /// one. Ignored unless `key` is reserved in this very generation.
    pub(crate) fn request_foreground(&mut self, key: &BuildKey, generation: u64) {
        if self.generation == Some(generation) && self.keys.contains(key) {
            self.foreground.insert(key.clone());
        }
    }

    /// Consume the request of `request_foreground` (once). A request of
    /// another generation was cleared with its reservation and is never seen.
    pub(crate) fn take_foreground(&mut self, key: &BuildKey, generation: u64) -> bool {
        self.generation == Some(generation) && self.foreground.remove(key)
    }
}

#[cfg(test)]
#[path = "related_scenes_build_registry_tests.rs"]
mod tests;
