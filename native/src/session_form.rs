//! Compare the rendered form, rather than optional storage defaults.
//! This keeps an absent/unsupported effort rendered as medium clean until edited.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionForm {
    pub title: String,
    pub model: String,
    pub effort_index: Option<usize>,
}

impl SessionForm {
    pub fn changed_from(&self, baseline: Option<&Self>) -> bool {
        baseline.is_some_and(|baseline| self != baseline)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn form() -> SessionForm {
        SessionForm {
            title: "Research 🦀".into(),
            model: "model-a".into(),
            effort_index: Some(3),
        }
    }

    #[test]
    fn unchanged_rendered_default_is_clean() {
        assert!(!form().changed_from(Some(&form())));
        assert!(!form().changed_from(None));
    }

    #[test]
    fn every_field_is_preserved_exactly() {
        let baseline = form();
        for changed in [
            SessionForm {
                title: "Research 🦀 ".into(),
                ..form()
            },
            SessionForm {
                model: "model-b".into(),
                ..form()
            },
            SessionForm {
                effort_index: Some(7),
                ..form()
            },
            SessionForm {
                effort_index: None,
                ..form()
            },
        ] {
            assert!(changed.changed_from(Some(&baseline)));
        }
    }

    #[test]
    fn reverting_or_accepting_new_baseline_clears_dirty_state() {
        let mut edited = form();
        edited.title = "New title".into();
        assert!(edited.changed_from(Some(&form())));
        assert!(!edited.changed_from(Some(&edited)));
        edited.title = form().title;
        assert!(!edited.changed_from(Some(&form())));
    }
}
