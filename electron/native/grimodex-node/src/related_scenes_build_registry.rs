use std::collections::HashSet;

type BuildKey = (u64, String);

/// Reservations follow the monotonically increasing SemanticRuntime generation.
/// Replaced jobs may finish later, but cannot release their successor's slot.
pub(crate) struct RelatedScenesBuildRegistry {
    generation: Option<u64>,
    keys: HashSet<BuildKey>,
    capacity: usize,
}

impl RelatedScenesBuildRegistry {
    pub(crate) fn new(capacity: usize) -> Self {
        Self {
            generation: None,
            keys: HashSet::new(),
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
        }
    }
}

#[cfg(test)]
#[path = "related_scenes_build_registry_tests.rs"]
mod tests;
