//! Zero-`eval()` Pure-Rust STEM Computation & Anti-Hallucination Verification Engine.
//!
//! Provides deterministic, bounded, side-effect-free verification primitives exposed via the
//! deferred `stem_verify` tool (preserving Token-0 7-tool KV-cache prefix invariance):
//! 1. Recursive-descent AST math calculator (`MAX_AST_DEPTH = 64`, zero shell/script eval).
//! 2. Static ReDoS catastrophic backtracking analyzer (`has_unsafe_redos_construct`).
//! 3. Numerical solvers: Newton-Bisection hybrid root finder, 4th-order Runge-Kutta ODE solver,
//!    N×N Gauss-Jordan matrix solver (RREF / Determinant / Inverse / Rank / Trace / `Ax = b`),
//!    Boolean SAT / Tautology / Contradiction solver, and 5-field UTC Vixie Cron validator.
//! 4. Rust-lifetime-aware multi-language syntax balance checker (`rust|ts|js|python|json|sql`).
//! 5. Deterministic numeric & citation claim verifier (never `"verified"` on 0 claims, capping
//!    epistemic confidence `<= 0.75`).

use crate::plugin::ToolSpec;
use anyhow::{bail, Context, Result};
use chrono::{DateTime, Datelike, Duration as ChronoDuration, TimeZone, Timelike, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// Hard recursion depth limit for the AST math and boolean parsers.
pub const MAX_AST_DEPTH: usize = 64;
/// Maximum input regex length admitted by the static ReDoS analyzer.
pub const MAX_REGEX_PATTERN_LEN: usize = 2_048;
/// Maximum distinct variables supported by the exact Boolean SAT truth-table solver (`2^12 = 4096`).
pub const MAX_BOOLEAN_VARS: usize = 12;
/// Maximum matrix dimension (`64x64`) admitted by the Gauss-Jordan solver.
pub const MAX_MATRIX_DIM: usize = 64;
/// Hard epistemic confidence ceiling enforced on deterministic claim verification.
pub const MAX_EPISTEMIC_SCORE: f64 = 0.75;

// ============================================================================
// 1. Zero-`eval()` Recursive-Descent AST Math Calculator (`MAX_AST_DEPTH = 64`)
// ============================================================================

#[derive(Debug, Clone, PartialEq)]
enum MathToken {
    Number(f64),
    Ident(String),
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    Caret,
    Bang,
    LParen,
    RParen,
    Comma,
}

#[derive(Debug, Clone)]
enum MathExpr {
    Num(f64),
    Var(String),
    UnaryNeg(Box<MathExpr>),
    Factorial(Box<MathExpr>),
    Binary {
        op: MathBinOp,
        lhs: Box<MathExpr>,
        rhs: Box<MathExpr>,
    },
    Call {
        name: String,
        args: Vec<MathExpr>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MathBinOp {
    Add,
    Sub,
    Mul,
    Div,
    Rem,
    Pow,
}

fn tokenize_math(input: &str) -> Result<Vec<MathToken>> {
    let bytes = input.as_bytes();
    let mut tokens = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        let ch = bytes[i] as char;
        if ch.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if ch.is_ascii_digit()
            || (ch == '.' && i + 1 < bytes.len() && (bytes[i + 1] as char).is_ascii_digit())
        {
            let start = i;
            let mut has_dot = ch == '.';
            i += 1;
            while i < bytes.len() {
                let c = bytes[i] as char;
                if c.is_ascii_digit() || c == '_' {
                    i += 1;
                } else if c == '.' && !has_dot {
                    has_dot = true;
                    i += 1;
                } else {
                    break;
                }
            }
            if i < bytes.len() && matches!(bytes[i] as char, 'e' | 'E') {
                let exp_pos = i;
                i += 1;
                if i < bytes.len() && matches!(bytes[i] as char, '+' | '-') {
                    i += 1;
                }
                let digits_start = i;
                while i < bytes.len() && (bytes[i] as char).is_ascii_digit() {
                    i += 1;
                }
                if i == digits_start {
                    bail!("malformed scientific notation at byte {exp_pos}");
                }
            }
            let raw = input[start..i].replace('_', "");
            let val = raw
                .parse::<f64>()
                .with_context(|| format!("invalid numeric literal `{raw}`"))?;
            tokens.push(MathToken::Number(val));
            continue;
        }
        if ch.is_ascii_alphabetic() || ch == '_' {
            let start = i;
            i += 1;
            while i < bytes.len()
                && ((bytes[i] as char).is_ascii_alphanumeric() || bytes[i] == b'_')
            {
                i += 1;
            }
            tokens.push(MathToken::Ident(input[start..i].to_owned()));
            continue;
        }
        match ch {
            '+' => {
                tokens.push(MathToken::Plus);
                i += 1;
            }
            '-' => {
                tokens.push(MathToken::Minus);
                i += 1;
            }
            '*' => {
                if i + 1 < bytes.len() && bytes[i + 1] == b'*' {
                    tokens.push(MathToken::Caret);
                    i += 2;
                } else {
                    tokens.push(MathToken::Star);
                    i += 1;
                }
            }
            '/' => {
                tokens.push(MathToken::Slash);
                i += 1;
            }
            '%' => {
                tokens.push(MathToken::Percent);
                i += 1;
            }
            '^' => {
                tokens.push(MathToken::Caret);
                i += 1;
            }
            '!' => {
                tokens.push(MathToken::Bang);
                i += 1;
            }
            '(' => {
                tokens.push(MathToken::LParen);
                i += 1;
            }
            ')' => {
                tokens.push(MathToken::RParen);
                i += 1;
            }
            ',' => {
                tokens.push(MathToken::Comma);
                i += 1;
            }
            other => bail!("unexpected character `{other}` in math expression at byte {i}"),
        }
    }
    Ok(tokens)
}

struct MathParser {
    tokens: Vec<MathToken>,
    pos: usize,
}

impl MathParser {
    fn parse(input: &str) -> Result<MathExpr> {
        let tokens = tokenize_math(input)?;
        if tokens.is_empty() {
            bail!("math expression must not be empty");
        }
        let mut parser = Self { tokens, pos: 0 };
        let expr = parser.parse_additive(0)?;
        if parser.pos < parser.tokens.len() {
            bail!("unexpected trailing token `{:?}`", parser.tokens[parser.pos]);
        }
        Ok(expr)
    }

    fn check_depth(depth: usize) -> Result<()> {
        if depth > MAX_AST_DEPTH {
            bail!("expression exceeds maximum AST depth ({MAX_AST_DEPTH})");
        }
        Ok(())
    }

    fn peek(&self) -> Option<&MathToken> {
        self.tokens.get(self.pos)
    }

    fn next(&mut self) -> Option<MathToken> {
        if self.pos < self.tokens.len() {
            let tok = self.tokens[self.pos].clone();
            self.pos += 1;
            Some(tok)
        } else {
            None
        }
    }

    fn parse_additive(&mut self, depth: usize) -> Result<MathExpr> {
        Self::check_depth(depth)?;
        let mut lhs = self.parse_multiplicative(depth + 1)?;
        while let Some(tok) = self.peek() {
            let op = match tok {
                MathToken::Plus => MathBinOp::Add,
                MathToken::Minus => MathBinOp::Sub,
                _ => break,
            };
            self.pos += 1;
            let rhs = self.parse_multiplicative(depth + 1)?;
            lhs = MathExpr::Binary {
                op,
                lhs: Box::new(lhs),
                rhs: Box::new(rhs),
            };
        }
        Ok(lhs)
    }

    fn parse_multiplicative(&mut self, depth: usize) -> Result<MathExpr> {
        Self::check_depth(depth)?;
        let mut lhs = self.parse_unary(depth + 1)?;
        while let Some(tok) = self.peek() {
            let op = match tok {
                MathToken::Star => MathBinOp::Mul,
                MathToken::Slash => MathBinOp::Div,
                MathToken::Percent => MathBinOp::Rem,
                _ => break,
            };
            self.pos += 1;
            let rhs = self.parse_unary(depth + 1)?;
            lhs = MathExpr::Binary {
                op,
                lhs: Box::new(lhs),
                rhs: Box::new(rhs),
            };
        }
        Ok(lhs)
    }

    fn parse_unary(&mut self, depth: usize) -> Result<MathExpr> {
        Self::check_depth(depth)?;
        match self.peek() {
            Some(MathToken::Plus) => {
                self.pos += 1;
                self.parse_unary(depth + 1)
            }
            Some(MathToken::Minus) => {
                self.pos += 1;
                let inner = self.parse_unary(depth + 1)?;
                Ok(MathExpr::UnaryNeg(Box::new(inner)))
            }
            _ => self.parse_power(depth + 1),
        }
    }

    fn parse_power(&mut self, depth: usize) -> Result<MathExpr> {
        Self::check_depth(depth)?;
        let lhs = self.parse_postfix(depth + 1)?;
        if matches!(self.peek(), Some(MathToken::Caret)) {
            self.pos += 1;
            let rhs = self.parse_unary(depth + 1)?;
            Ok(MathExpr::Binary {
                op: MathBinOp::Pow,
                lhs: Box::new(lhs),
                rhs: Box::new(rhs),
            })
        } else {
            Ok(lhs)
        }
    }

    fn parse_postfix(&mut self, depth: usize) -> Result<MathExpr> {
        Self::check_depth(depth)?;
        let mut expr = self.parse_primary(depth + 1)?;
        while matches!(self.peek(), Some(MathToken::Bang)) {
            self.pos += 1;
            expr = MathExpr::Factorial(Box::new(expr));
        }
        Ok(expr)
    }

    fn parse_primary(&mut self, depth: usize) -> Result<MathExpr> {
        Self::check_depth(depth)?;
        match self.next() {
            Some(MathToken::Number(n)) => Ok(MathExpr::Num(n)),
            Some(MathToken::Ident(name)) => {
                if matches!(self.peek(), Some(MathToken::LParen)) {
                    self.pos += 1;
                    let mut args = Vec::new();
                    if !matches!(self.peek(), Some(MathToken::RParen)) {
                        loop {
                            args.push(self.parse_additive(depth + 1)?);
                            if matches!(self.peek(), Some(MathToken::Comma)) {
                                self.pos += 1;
                            } else {
                                break;
                            }
                        }
                    }
                    if !matches!(self.next(), Some(MathToken::RParen)) {
                        bail!("missing closing `)` in call to `{name}`");
                    }
                    Ok(MathExpr::Call { name, args })
                } else {
                    Ok(MathExpr::Var(name))
                }
            }
            Some(MathToken::LParen) => {
                let inner = self.parse_additive(depth + 1)?;
                if !matches!(self.next(), Some(MathToken::RParen)) {
                    bail!("missing closing `)` in parenthesized expression");
                }
                Ok(inner)
            }
            other => bail!("unexpected token `{other:?}` while parsing math expression"),
        }
    }
}

fn eval_ast(expr: &MathExpr, vars: &HashMap<String, f64>, depth: usize) -> Result<f64> {
    if depth > MAX_AST_DEPTH {
        bail!("evaluation exceeds maximum AST depth ({MAX_AST_DEPTH})");
    }
    let val = match expr {
        MathExpr::Num(n) => *n,
        MathExpr::Var(name) => {
            if let Some(&v) = vars.get(name) {
                v
            } else {
                match name.to_ascii_lowercase().as_str() {
                    "pi" => std::f64::consts::PI,
                    "e" => std::f64::consts::E,
                    "tau" => std::f64::consts::TAU,
                    "phi" => (1.0 + 5.0_f64.sqrt()) * 0.5,
                    _ => bail!("undefined math identifier `{name}`"),
                }
            }
        }
        MathExpr::UnaryNeg(inner) => -eval_ast(inner, vars, depth + 1)?,
        MathExpr::Factorial(inner) => {
            let v = eval_ast(inner, vars, depth + 1)?;
            if !v.is_finite() || v < 0.0 || (v - v.round()).abs() > 1e-12 || v > 170.0 {
                bail!("factorial requires an integer in 0..=170 (got {v})");
            }
            let n = v.round() as u64;
            let mut acc = 1.0_f64;
            for k in 2..=n {
                acc *= k as f64;
            }
            acc
        }
        MathExpr::Binary { op, lhs, rhs } => {
            let a = eval_ast(lhs, vars, depth + 1)?;
            let b = eval_ast(rhs, vars, depth + 1)?;
            match op {
                MathBinOp::Add => a + b,
                MathBinOp::Sub => a - b,
                MathBinOp::Mul => a * b,
                MathBinOp::Div => {
                    if b == 0.0 {
                        bail!("division by zero");
                    }
                    a / b
                }
                MathBinOp::Rem => {
                    if b == 0.0 {
                        bail!("modulo by zero");
                    }
                    a % b
                }
                MathBinOp::Pow => a.powf(b),
            }
        }
        MathExpr::Call { name, args } => {
            let mut ev = Vec::with_capacity(args.len());
            for arg in args {
                ev.push(eval_ast(arg, vars, depth + 1)?);
            }
            eval_builtin_fn(&name.to_ascii_lowercase(), &ev)?
        }
    };
    if !val.is_finite() {
        bail!("non-finite numerical result ({val})");
    }
    Ok(val)
}

fn eval_builtin_fn(name: &str, args: &[f64]) -> Result<f64> {
    let require_n = |expected: usize| -> Result<()> {
        if args.len() != expected {
            bail!("function `{name}` requires {expected} argument(s), got {}", args.len());
        }
        Ok(())
    };
    match name {
        "sin" => {
            require_n(1)?;
            Ok(args[0].sin())
        }
        "cos" => {
            require_n(1)?;
            Ok(args[0].cos())
        }
        "tan" => {
            require_n(1)?;
            Ok(args[0].tan())
        }
        "asin" => {
            require_n(1)?;
            Ok(args[0].asin())
        }
        "acos" => {
            require_n(1)?;
            Ok(args[0].acos())
        }
        "atan" => {
            require_n(1)?;
            Ok(args[0].atan())
        }
        "atan2" => {
            require_n(2)?;
            Ok(args[0].atan2(args[1]))
        }
        "sinh" => {
            require_n(1)?;
            Ok(args[0].sinh())
        }
        "cosh" => {
            require_n(1)?;
            Ok(args[0].cosh())
        }
        "tanh" => {
            require_n(1)?;
            Ok(args[0].tanh())
        }
        "sqrt" => {
            require_n(1)?;
            if args[0] < 0.0 {
                bail!("sqrt domain error: negative input {}", args[0]);
            }
            Ok(args[0].sqrt())
        }
        "cbrt" => {
            require_n(1)?;
            Ok(args[0].cbrt())
        }
        "abs" => {
            require_n(1)?;
            Ok(args[0].abs())
        }
        "floor" => {
            require_n(1)?;
            Ok(args[0].floor())
        }
        "ceil" => {
            require_n(1)?;
            Ok(args[0].ceil())
        }
        "round" => {
            require_n(1)?;
            Ok(args[0].round())
        }
        "ln" => {
            require_n(1)?;
            if args[0] <= 0.0 {
                bail!("ln domain error: non-positive input {}", args[0]);
            }
            Ok(args[0].ln())
        }
        "log10" | "log" => {
            if args.len() == 1 {
                if args[0] <= 0.0 {
                    bail!("log domain error: non-positive input {}", args[0]);
                }
                Ok(if name == "log10" {
                    args[0].log10()
                } else {
                    args[0].ln()
                })
            } else if args.len() == 2 {
                if args[0] <= 0.0 || args[1] <= 0.0 || (args[1] - 1.0).abs() < f64::EPSILON {
                    bail!("log(x, base) domain error");
                }
                Ok(args[0].log(args[1]))
            } else {
                bail!("`{name}` expects 1 or 2 arguments");
            }
        }
        "log2" => {
            require_n(1)?;
            if args[0] <= 0.0 {
                bail!("log2 domain error: non-positive input {}", args[0]);
            }
            Ok(args[0].log2())
        }
        "exp" => {
            require_n(1)?;
            Ok(args[0].exp())
        }
        "pow" => {
            require_n(2)?;
            Ok(args[0].powf(args[1]))
        }
        "min" => {
            if args.is_empty() {
                bail!("min requires at least 1 argument");
            }
            Ok(args.iter().copied().fold(f64::INFINITY, f64::min))
        }
        "max" => {
            if args.is_empty() {
                bail!("max requires at least 1 argument");
            }
            Ok(args.iter().copied().fold(f64::NEG_INFINITY, f64::max))
        }
        "clamp" => {
            require_n(3)?;
            Ok(args[0].clamp(args[1], args[2]))
        }
        "ncr" | "comb" => {
            require_n(2)?;
            let n = to_nonneg_u64(args[0], "ncr")?;
            let r = to_nonneg_u64(args[1], "ncr")?;
            if r > n {
                return Ok(0.0);
            }
            let k = r.min(n - r);
            let mut acc = 1.0_f64;
            for i in 1..=k {
                acc = acc * ((n - k + i) as f64) / (i as f64);
            }
            Ok(acc.round())
        }
        "npr" | "perm" => {
            require_n(2)?;
            let n = to_nonneg_u64(args[0], "npr")?;
            let r = to_nonneg_u64(args[1], "npr")?;
            if r > n {
                return Ok(0.0);
            }
            let mut acc = 1.0_f64;
            for i in 0..r {
                acc *= (n - i) as f64;
            }
            Ok(acc)
        }
        "gcd" => {
            require_n(2)?;
            let mut a = to_nonneg_u64(args[0].abs(), "gcd")?;
            let mut b = to_nonneg_u64(args[1].abs(), "gcd")?;
            while b != 0 {
                let t = a % b;
                a = b;
                b = t;
            }
            Ok(a as f64)
        }
        "lcm" => {
            require_n(2)?;
            let a = to_nonneg_u64(args[0].abs(), "lcm")?;
            let b = to_nonneg_u64(args[1].abs(), "lcm")?;
            if a == 0 || b == 0 {
                return Ok(0.0);
            }
            let mut x = a;
            let mut y = b;
            while y != 0 {
                let t = x % y;
                x = y;
                y = t;
            }
            Ok(((a / x) as f64) * (b as f64))
        }
        _ => bail!("unsupported math function `{name}`"),
    }
}

fn to_nonneg_u64(v: f64, ctx: &str) -> Result<u64> {
    if !v.is_finite() || v < 0.0 || (v - v.round()).abs() > 1e-9 || v > 1e15 {
        bail!("{ctx} requires non-negative integer arguments (got {v})");
    }
    Ok(v.round() as u64)
}

/// Evaluates a pure mathematical expression with optional variable bindings (`MAX_AST_DEPTH = 64`).
pub fn eval_math_expr(expr: &str, vars: &HashMap<String, f64>) -> Result<f64> {
    let ast = MathParser::parse(expr)?;
    eval_ast(&ast, vars, 0)
}

// ============================================================================
// 2. Static ReDoS Catastrophic Backtracking Analyzer
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedosReport {
    pub safe: bool,
    pub risk: String,
    pub findings: Vec<String>,
    pub pattern_len: usize,
}

#[derive(Debug, Clone)]
struct RegexGroupFrame {
    has_inner_quantifier: bool,
    branches: Vec<String>,
    current_branch: String,
}

fn parse_quantifier_at(chars: &[char], idx: usize) -> Option<(usize, bool)> {
    match *chars.get(idx)? {
        '+' | '*' => {
            let mut end = idx + 1;
            if matches!(chars.get(end), Some('?' | '+')) {
                end += 1;
            }
            Some((end, true))
        }
        '?' => {
            let mut end = idx + 1;
            if matches!(chars.get(end), Some('?' | '+')) {
                end += 1;
            }
            Some((end, false))
        }
        '{' => {
            let mut j = idx + 1;
            let mut first = String::new();
            while j < chars.len() && chars[j].is_ascii_digit() {
                first.push(chars[j]);
                j += 1;
            }
            if first.is_empty() {
                return None;
            }
            let repeating = if j < chars.len() && chars[j] == ',' {
                j += 1;
                let mut second = String::new();
                while j < chars.len() && chars[j].is_ascii_digit() {
                    second.push(chars[j]);
                    j += 1;
                }
                if j >= chars.len() || chars[j] != '}' {
                    return None;
                }
                second.is_empty() || second.parse::<usize>().map_or(true, |hi| hi > 1)
            } else if j < chars.len() && chars[j] == '}' {
                first.parse::<usize>().is_ok_and(|n| n > 1)
            } else {
                return None;
            };
            let mut end = j + 1;
            if matches!(chars.get(end), Some('?' | '+')) {
                end += 1;
            }
            Some((end, repeating))
        }
        _ => None,
    }
}

fn branches_potentially_overlap(branches: &[String]) -> bool {
    if branches.len() < 2 {
        return false;
    }
    let normalized: Vec<&str> = branches.iter().map(|s| s.trim()).collect();
    for i in 0..normalized.len() {
        for j in (i + 1)..normalized.len() {
            let a = normalized[i];
            let b = normalized[j];
            if a.is_empty() || b.is_empty() {
                return true;
            }
            if a == b || a.starts_with(b) || b.starts_with(a) {
                return true;
            }
            let ca = a.chars().next();
            let cb = b.chars().next();
            if ca == cb {
                return true;
            }
            let a_wild = a.starts_with('.') || a.starts_with("\\w") || a.starts_with("\\s") || a.starts_with("\\d");
            let b_wild = b.starts_with('.') || b.starts_with("\\w") || b.starts_with("\\s") || b.starts_with("\\d");
            if (a_wild && b_wild)
                || (a.starts_with('.') || b.starts_with('.'))
                || (a.starts_with("\\w") && cb.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_'))
                || (b.starts_with("\\w") && ca.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_'))
                || (a.starts_with("\\d") && cb.is_some_and(|c| c.is_ascii_digit()))
                || (b.starts_with("\\d") && ca.is_some_and(|c| c.is_ascii_digit()))
            {
                return true;
            }
        }
    }
    false
}

/// Statically analyzes a regex pattern for catastrophic backtracking (ReDoS) constructs
/// without executing the regex engine.
#[must_use]
pub fn analyze_redos(pattern: &str) -> RedosReport {
    let mut findings = Vec::new();
    let pattern_len = pattern.len();
    if pattern_len > MAX_REGEX_PATTERN_LEN {
        findings.push(format!(
            "pattern length ({pattern_len}) exceeds safe cap ({MAX_REGEX_PATTERN_LEN})"
        ));
    }

    let chars: Vec<char> = pattern.chars().collect();
    let mut stack: Vec<RegexGroupFrame> = Vec::new();
    let mut in_char_class = false;
    let mut i = 0usize;
    let mut prev_unbounded_wildcard = false;

    while i < chars.len() {
        let ch = chars[i];
        if ch == '\\' {
            let atom = if i + 1 < chars.len() {
                format!("\\{}", chars[i + 1])
            } else {
                "\\".to_owned()
            };
            if let Some(top) = stack.last_mut() {
                if !in_char_class {
                    top.current_branch.push_str(&atom);
                }
            }
            i = (i + 2).min(chars.len());
            if !in_char_class {
                if let Some((end, repeating)) = parse_quantifier_at(&chars, i) {
                    if repeating {
                        if let Some(top) = stack.last_mut() {
                            top.has_inner_quantifier = true;
                        }
                    }
                    i = end;
                }
                prev_unbounded_wildcard = false;
            }
            continue;
        }

        if in_char_class {
            if ch == ']' {
                in_char_class = false;
                if let Some((end, repeating)) = parse_quantifier_at(&chars, i + 1) {
                    if repeating {
                        if let Some(top) = stack.last_mut() {
                            top.has_inner_quantifier = true;
                        }
                    }
                    i = end;
                    prev_unbounded_wildcard = false;
                    continue;
                }
            }
            i += 1;
            continue;
        }

        match ch {
            '[' => {
                in_char_class = true;
                if let Some(top) = stack.last_mut() {
                    top.current_branch.push('[');
                }
                prev_unbounded_wildcard = false;
                i += 1;
            }
            '(' => {
                stack.push(RegexGroupFrame {
                    has_inner_quantifier: false,
                    branches: Vec::new(),
                    current_branch: String::new(),
                });
                i += 1;
                if i < chars.len() && chars[i] == '?' {
                    i += 1;
                    if i < chars.len() && matches!(chars[i], ':' | '=' | '!') {
                        i += 1;
                    } else if i + 1 < chars.len()
                        && chars[i] == '<'
                        && matches!(chars[i + 1], '=' | '!')
                    {
                        i += 2;
                    }
                }
                prev_unbounded_wildcard = false;
            }
            '|' => {
                if let Some(top) = stack.last_mut() {
                    let done = std::mem::take(&mut top.current_branch);
                    top.branches.push(done);
                }
                prev_unbounded_wildcard = false;
                i += 1;
            }
            ')' => {
                i += 1;
                let popped = stack.pop();
                let quant = parse_quantifier_at(&chars, i);
                let mut outer_repeating = false;
                if let Some((end, repeating)) = quant {
                    outer_repeating = repeating;
                    i = end;
                }
                if let Some(mut frame) = popped {
                    let last = std::mem::take(&mut frame.current_branch);
                    frame.branches.push(last);
                    if outer_repeating {
                        if frame.has_inner_quantifier {
                            findings.push(
                                "nested_quantifier: quantified group contains an inner repeating quantifier (exponential ReDoS risk)"
                                    .into(),
                            );
                        }
                        if branches_potentially_overlap(&frame.branches) {
                            findings.push(
                                "overlapping_alternation: quantified group has overlapping alternation branches (exponential ReDoS risk)"
                                    .into(),
                            );
                        }
                    }
                    if let Some(parent) = stack.last_mut() {
                        if frame.has_inner_quantifier || outer_repeating {
                            parent.has_inner_quantifier = true;
                        }
                        if let Some(first_b) = frame.branches.first() {
                            parent.current_branch.push_str(first_b);
                        }
                    }
                }
                prev_unbounded_wildcard = false;
            }
            '.' => {
                if let Some(top) = stack.last_mut() {
                    top.current_branch.push('.');
                }
                if let Some((end, repeating)) = parse_quantifier_at(&chars, i + 1) {
                    if repeating {
                        if let Some(top) = stack.last_mut() {
                            top.has_inner_quantifier = true;
                        }
                        if prev_unbounded_wildcard {
                            findings.push(
                                "adjacent_wildcards: back-to-back unbounded wildcards (`.*.*`/`.+.+`) risk quadratic backtracking"
                                    .into(),
                            );
                        }
                        prev_unbounded_wildcard = true;
                    } else {
                        prev_unbounded_wildcard = false;
                    }
                    i = end;
                } else {
                    prev_unbounded_wildcard = false;
                    i += 1;
                }
            }
            _ => {
                if let Some(top) = stack.last_mut() {
                    top.current_branch.push(ch);
                }
                if let Some((end, repeating)) = parse_quantifier_at(&chars, i + 1) {
                    if repeating {
                        if let Some(top) = stack.last_mut() {
                            top.has_inner_quantifier = true;
                        }
                    }
                    i = end;
                } else {
                    i += 1;
                }
                prev_unbounded_wildcard = false;
            }
        }
    }

    let safe = findings.is_empty();
    let risk = if safe {
        "safe".to_owned()
    } else if findings
        .iter()
        .any(|f| f.starts_with("nested_quantifier") || f.starts_with("overlapping_alternation"))
    {
        "high".to_owned()
    } else {
        "medium".to_owned()
    };

    RedosReport {
        safe,
        risk,
        findings,
        pattern_len,
    }
}

/// Returns `true` when `pattern` contains a static catastrophic-backtracking ReDoS construct.
#[must_use]
pub fn has_unsafe_redos_construct(pattern: &str) -> bool {
    !analyze_redos(pattern).safe
}

// ============================================================================
// 3. Numerical Solvers (Root Finder, RK4 ODE, Matrix RREF/Det/Inv, SAT, Cron)
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootResult {
    pub root: f64,
    pub residual: f64,
    pub iterations: usize,
    pub method: String,
    pub converged: bool,
}

/// Solves `f(var) = 0` using a bracket-guarded hybrid Newton-Raphson + Bisection solver.
pub fn solve_root(
    expr: &str,
    var: &str,
    a: f64,
    b: f64,
    tol: f64,
    max_iter: usize,
) -> Result<RootResult> {
    let ast = MathParser::parse(expr)?;
    let tol = tol.clamp(1e-14, 1e-1);
    let max_iter = max_iter.clamp(1, 5_000);
    let eval_at = |x: f64| -> Result<f64> {
        let mut vars = HashMap::new();
        vars.insert(var.to_owned(), x);
        eval_ast(&ast, &vars, 0)
    };

    let mut lo = a.min(b);
    let mut hi = a.max(b);
    let mut f_lo = eval_at(lo)?;
    let mut f_hi = eval_at(hi)?;

    if f_lo.abs() <= tol {
        return Ok(RootResult {
            root: lo,
            residual: f_lo,
            iterations: 0,
            method: "endpoint".into(),
            converged: true,
        });
    }
    if f_hi.abs() <= tol {
        return Ok(RootResult {
            root: hi,
            residual: f_hi,
            iterations: 0,
            method: "endpoint".into(),
            converged: true,
        });
    }

    let bracketed = (f_lo < 0.0 && f_hi > 0.0) || (f_lo > 0.0 && f_hi < 0.0);
    let mut x = 0.5 * (lo + hi);
    let mut used_newton = false;
    let mut used_bisect = false;

    for iter in 1..=max_iter {
        let fx = eval_at(x)?;
        if fx.abs() <= tol || (bracketed && (hi - lo).abs() <= tol) {
            return Ok(RootResult {
                root: x,
                residual: fx,
                iterations: iter,
                method: match (used_newton, used_bisect) {
                    (true, true) => "newton-bisection".into(),
                    (true, false) => "newton".into(),
                    _ => "bisection".into(),
                },
                converged: true,
            });
        }

        if bracketed {
            if (f_lo < 0.0 && fx < 0.0) || (f_lo > 0.0 && fx > 0.0) {
                lo = x;
                f_lo = fx;
            } else {
                hi = x;
                f_hi = fx;
            }
            let _ = f_hi;
        }

        let h = 1e-7 * x.abs().max(1.0);
        let df = match (eval_at(x + h), eval_at(x - h)) {
            (Ok(fp), Ok(fm)) => (fp - fm) / (2.0 * h),
            _ => 0.0,
        };
        let newton_cand = if df.is_finite() && df.abs() > 1e-14 {
            Some(x - fx / df)
        } else {
            None
        };

        if let Some(xn) = newton_cand.filter(|v| v.is_finite()) {
            if !bracketed || (xn > lo && xn < hi) {
                x = xn;
                used_newton = true;
                continue;
            }
        }
        if bracketed {
            x = 0.5 * (lo + hi);
            used_bisect = true;
        } else {
            bail!("unbracketed Newton step stalled at x={x} (f(x)={fx}, df={df})");
        }
    }

    let fx = eval_at(x)?;
    Ok(RootResult {
        root: x,
        residual: fx,
        iterations: max_iter,
        method: "newton-bisection".into(),
        converged: fx.abs() <= tol * 10.0,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OdeRk4Result {
    pub t_final: f64,
    pub y_final: f64,
    pub steps: usize,
    pub step_size: f64,
    pub samples: Vec<(f64, f64)>,
}

/// Integrates the scalar initial-value ODE `dy/dt = expr(t, y)` via classical 4th-order Runge-Kutta.
pub fn solve_ode_rk4(
    expr: &str,
    t0: f64,
    y0: f64,
    t_end: f64,
    steps: usize,
) -> Result<OdeRk4Result> {
    let ast = MathParser::parse(expr)?;
    let steps = steps.clamp(1, 100_000);
    let h = (t_end - t0) / (steps as f64);
    let mut vars = HashMap::new();
    let eval_f = |t: f64, y: f64, v: &mut HashMap<String, f64>| -> Result<f64> {
        v.insert("t".to_owned(), t);
        v.insert("x".to_owned(), t);
        v.insert("y".to_owned(), y);
        eval_ast(&ast, v, 0)
    };

    let mut t = t0;
    let mut y = y0;
    let sample_stride = (steps / 32).max(1);
    let mut samples = Vec::with_capacity(34);
    samples.push((t, y));

    for step in 1..=steps {
        let k1 = eval_f(t, y, &mut vars)?;
        let k2 = eval_f(t + 0.5 * h, y + 0.5 * h * k1, &mut vars)?;
        let k3 = eval_f(t + 0.5 * h, y + 0.5 * h * k2, &mut vars)?;
        let k4 = eval_f(t + h, y + h * k3, &mut vars)?;
        y += (h / 6.0) * (k1 + 2.0 * k2 + 2.0 * k3 + k4);
        t = t0 + (step as f64) * h;
        if !y.is_finite() {
            bail!("RK4 solution diverged to non-finite value at step {step} (t={t})");
        }
        if step % sample_stride == 0 || step == steps {
            samples.push((t, y));
        }
    }

    Ok(OdeRk4Result {
        t_final: t,
        y_final: y,
        steps,
        step_size: h,
        samples,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixResult {
    pub rows: usize,
    pub cols: usize,
    pub rank: usize,
    pub trace: Option<f64>,
    pub determinant: Option<f64>,
    pub rref: Vec<Vec<f64>>,
    pub inverse: Option<Vec<Vec<f64>>>,
    pub solution: Option<Vec<f64>>,
}

fn clean_zero(v: f64) -> f64 {
    if v.abs() < 1e-12 {
        0.0
    } else {
        v
    }
}

/// Performs Gauss-Jordan elimination with partial pivoting computing RREF, rank, trace,
/// determinant, inverse (when nonsingular square), and optional linear system solution `Ax = b`.
pub fn solve_matrix(matrix: &[Vec<f64>], rhs: Option<&[f64]>) -> Result<MatrixResult> {
    let rows = matrix.len();
    if rows == 0 || rows > MAX_MATRIX_DIM {
        bail!("matrix row count must be in 1..={MAX_MATRIX_DIM}");
    }
    let cols = matrix[0].len();
    if cols == 0 || cols > MAX_MATRIX_DIM {
        bail!("matrix col count must be in 1..={MAX_MATRIX_DIM}");
    }
    for (r_idx, row) in matrix.iter().enumerate() {
        if row.len() != cols {
            bail!("ragged matrix: row {r_idx} has {} cols, expected {cols}", row.len());
        }
        if row.iter().any(|v| !v.is_finite()) {
            bail!("matrix contains non-finite entry in row {r_idx}");
        }
    }

    let square = rows == cols;
    let trace = if square {
        Some((0..rows).map(|i| matrix[i][i]).sum())
    } else {
        None
    };

    // Compute RREF and rank (plus determinant when square).
    let mut rref = matrix.to_vec();
    let mut rank = 0usize;
    let mut det_sign = 1.0_f64;
    let mut det_product = 1.0_f64;

    for col in 0..cols {
        if rank >= rows {
            break;
        }
        let mut pivot_row = rank;
        let mut max_val = rref[rank][col].abs();
        for (r, row) in rref.iter().enumerate().skip(rank + 1) {
            let v = row[col].abs();
            if v > max_val {
                max_val = v;
                pivot_row = r;
            }
        }
        if max_val < 1e-12 {
            if square {
                det_product = 0.0;
            }
            continue;
        }
        if pivot_row != rank {
            rref.swap(pivot_row, rank);
            det_sign = -det_sign;
        }
        let pivot = rref[rank][col];
        det_product *= pivot;
        for cell in &mut rref[rank][col..cols] {
            *cell /= pivot;
        }
        for r in 0..rows {
            if r != rank {
                let factor = rref[r][col];
                if factor.abs() > 1e-15 {
                    for c in col..cols {
                        let sub = factor * rref[rank][c];
                        rref[r][c] -= sub;
                    }
                }
            }
        }
        rank += 1;
    }

    for row in &mut rref {
        for cell in row {
            *cell = clean_zero(*cell);
        }
    }

    let determinant = if square {
        let d = if rank < rows {
            0.0
        } else {
            clean_zero(det_sign * det_product)
        };
        Some(d)
    } else {
        None
    };

    // Compute inverse via augmented [A | I] when square and full rank.
    let inverse = if square && rank == rows {
        let n = rows;
        let mut aug = vec![vec![0.0_f64; 2 * n]; n];
        for i in 0..n {
            for j in 0..n {
                aug[i][j] = matrix[i][j];
            }
            aug[i][n + i] = 1.0;
        }
        let mut invertible = true;
        for i in 0..n {
            let mut piv = i;
            let mut best = aug[i][i].abs();
            for (r, row) in aug.iter().enumerate().skip(i + 1) {
                if row[i].abs() > best {
                    best = row[i].abs();
                    piv = r;
                }
            }
            if best < 1e-12 {
                invertible = false;
                break;
            }
            if piv != i {
                aug.swap(piv, i);
            }
            let d = aug[i][i];
            for cell in &mut aug[i] {
                *cell /= d;
            }
            for r in 0..n {
                if r != i {
                    let f = aug[r][i];
                    if f.abs() > 1e-15 {
                        for c in 0..(2 * n) {
                            let sub = f * aug[i][c];
                            aug[r][c] -= sub;
                        }
                    }
                }
            }
        }
        if invertible {
            Some(
                aug.into_iter()
                    .map(|row| row[n..].iter().copied().map(clean_zero).collect::<Vec<f64>>())
                    .collect::<Vec<Vec<f64>>>(),
            )
        } else {
            None
        }
    } else {
        None
    };

    // Solve Ax = b if rhs vector provided.
    let solution = if let Some(b) = rhs {
        if b.len() != rows {
            bail!("rhs length ({}) must match matrix row count ({rows})", b.len());
        }
        if let Some(ref inv) = inverse {
            let mut sol = vec![0.0_f64; cols];
            for i in 0..cols {
                let mut sum = 0.0;
                for j in 0..rows {
                    sum += inv[i][j] * b[j];
                }
                sol[i] = clean_zero(sum);
            }
            Some(sol)
        } else {
            None
        }
    } else {
        None
    };

    Ok(MatrixResult {
        rows,
        cols,
        rank,
        trace,
        determinant,
        rref,
        inverse,
        solution,
    })
}

// --- Boolean SAT / Tautology / Contradiction Solver ---

#[derive(Debug, Clone, PartialEq, Eq)]
enum BoolToken {
    Ident(String),
    Const(bool),
    Not,
    And,
    Or,
    Xor,
    Implies,
    Iff,
    LParen,
    RParen,
}

#[derive(Debug, Clone)]
enum BoolExpr {
    Const(bool),
    Var(String),
    Not(Box<BoolExpr>),
    And(Box<BoolExpr>, Box<BoolExpr>),
    Or(Box<BoolExpr>, Box<BoolExpr>),
    Xor(Box<BoolExpr>, Box<BoolExpr>),
    Implies(Box<BoolExpr>, Box<BoolExpr>),
    Iff(Box<BoolExpr>, Box<BoolExpr>),
}

fn tokenize_bool(input: &str) -> Result<Vec<BoolToken>> {
    let chars: Vec<char> = input.chars().collect();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < chars.len() {
        let ch = chars[i];
        if ch.is_whitespace() {
            i += 1;
            continue;
        }
        if ch == '<' && i + 2 < chars.len() && chars[i + 1] == '-' && chars[i + 2] == '>' {
            out.push(BoolToken::Iff);
            i += 3;
            continue;
        }
        if ch == '-' && i + 1 < chars.len() && chars[i + 1] == '>' {
            out.push(BoolToken::Implies);
            i += 2;
            continue;
        }
        if ch == '&' {
            i += if i + 1 < chars.len() && chars[i + 1] == '&' {
                2
            } else {
                1
            };
            out.push(BoolToken::And);
            continue;
        }
        if ch == '|' {
            i += if i + 1 < chars.len() && chars[i + 1] == '|' {
                2
            } else {
                1
            };
            out.push(BoolToken::Or);
            continue;
        }
        match ch {
            '!' | '~' => {
                out.push(BoolToken::Not);
                i += 1;
            }
            '^' => {
                out.push(BoolToken::Xor);
                i += 1;
            }
            '(' => {
                out.push(BoolToken::LParen);
                i += 1;
            }
            ')' => {
                out.push(BoolToken::RParen);
                i += 1;
            }
            '0' => {
                out.push(BoolToken::Const(false));
                i += 1;
            }
            '1' => {
                out.push(BoolToken::Const(true));
                i += 1;
            }
            c if c.is_ascii_alphabetic() || c == '_' => {
                let start = i;
                i += 1;
                while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_') {
                    i += 1;
                }
                let word: String = chars[start..i].iter().collect();
                match word.to_ascii_uppercase().as_str() {
                    "TRUE" => out.push(BoolToken::Const(true)),
                    "FALSE" => out.push(BoolToken::Const(false)),
                    "AND" => out.push(BoolToken::And),
                    "OR" => out.push(BoolToken::Or),
                    "XOR" => out.push(BoolToken::Xor),
                    "NOT" => out.push(BoolToken::Not),
                    "IMPLIES" => out.push(BoolToken::Implies),
                    "IFF" => out.push(BoolToken::Iff),
                    _ => out.push(BoolToken::Ident(word)),
                }
            }
            other => bail!("unexpected token `{other}` in boolean formula"),
        }
    }
    Ok(out)
}

struct BoolParser {
    tokens: Vec<BoolToken>,
    pos: usize,
}

impl BoolParser {
    fn parse(input: &str) -> Result<BoolExpr> {
        let tokens = tokenize_bool(input)?;
        if tokens.is_empty() {
            bail!("boolean formula must not be empty");
        }
        let mut p = Self { tokens, pos: 0 };
        let expr = p.parse_iff(0)?;
        if p.pos < p.tokens.len() {
            bail!("unexpected trailing token `{:?}` in boolean formula", p.tokens[p.pos]);
        }
        Ok(expr)
    }

    fn peek(&self) -> Option<&BoolToken> {
        self.tokens.get(self.pos)
    }

    fn parse_iff(&mut self, depth: usize) -> Result<BoolExpr> {
        if depth > MAX_AST_DEPTH {
            bail!("boolean formula exceeds maximum AST depth ({MAX_AST_DEPTH})");
        }
        let mut lhs = self.parse_implies(depth + 1)?;
        while matches!(self.peek(), Some(BoolToken::Iff)) {
            self.pos += 1;
            let rhs = self.parse_implies(depth + 1)?;
            lhs = BoolExpr::Iff(Box::new(lhs), Box::new(rhs));
        }
        Ok(lhs)
    }

    fn parse_implies(&mut self, depth: usize) -> Result<BoolExpr> {
        if depth > MAX_AST_DEPTH {
            bail!("boolean formula exceeds maximum AST depth ({MAX_AST_DEPTH})");
        }
        let lhs = self.parse_xor(depth + 1)?;
        if matches!(self.peek(), Some(BoolToken::Implies)) {
            self.pos += 1;
            let rhs = self.parse_implies(depth + 1)?;
            Ok(BoolExpr::Implies(Box::new(lhs), Box::new(rhs)))
        } else {
            Ok(lhs)
        }
    }

    fn parse_xor(&mut self, depth: usize) -> Result<BoolExpr> {
        if depth > MAX_AST_DEPTH {
            bail!("boolean formula exceeds maximum AST depth ({MAX_AST_DEPTH})");
        }
        let mut lhs = self.parse_or(depth + 1)?;
        while matches!(self.peek(), Some(BoolToken::Xor)) {
            self.pos += 1;
            let rhs = self.parse_or(depth + 1)?;
            lhs = BoolExpr::Xor(Box::new(lhs), Box::new(rhs));
        }
        Ok(lhs)
    }

    fn parse_or(&mut self, depth: usize) -> Result<BoolExpr> {
        if depth > MAX_AST_DEPTH {
            bail!("boolean formula exceeds maximum AST depth ({MAX_AST_DEPTH})");
        }
        let mut lhs = self.parse_and(depth + 1)?;
        while matches!(self.peek(), Some(BoolToken::Or)) {
            self.pos += 1;
            let rhs = self.parse_and(depth + 1)?;
            lhs = BoolExpr::Or(Box::new(lhs), Box::new(rhs));
        }
        Ok(lhs)
    }

    fn parse_and(&mut self, depth: usize) -> Result<BoolExpr> {
        if depth > MAX_AST_DEPTH {
            bail!("boolean formula exceeds maximum AST depth ({MAX_AST_DEPTH})");
        }
        let mut lhs = self.parse_not(depth + 1)?;
        while matches!(self.peek(), Some(BoolToken::And)) {
            self.pos += 1;
            let rhs = self.parse_not(depth + 1)?;
            lhs = BoolExpr::And(Box::new(lhs), Box::new(rhs));
        }
        Ok(lhs)
    }

    fn parse_not(&mut self, depth: usize) -> Result<BoolExpr> {
        if depth > MAX_AST_DEPTH {
            bail!("boolean formula exceeds maximum AST depth ({MAX_AST_DEPTH})");
        }
        if matches!(self.peek(), Some(BoolToken::Not)) {
            self.pos += 1;
            Ok(BoolExpr::Not(Box::new(self.parse_not(depth + 1)?)))
        } else {
            self.parse_atom(depth + 1)
        }
    }

    fn parse_atom(&mut self, depth: usize) -> Result<BoolExpr> {
        if depth > MAX_AST_DEPTH {
            bail!("boolean formula exceeds maximum AST depth ({MAX_AST_DEPTH})");
        }
        let tok = self
            .tokens
            .get(self.pos)
            .cloned()
            .context("unexpected end of boolean formula")?;
        self.pos += 1;
        match tok {
            BoolToken::Const(b) => Ok(BoolExpr::Const(b)),
            BoolToken::Ident(v) => Ok(BoolExpr::Var(v)),
            BoolToken::LParen => {
                let inner = self.parse_iff(depth + 1)?;
                if !matches!(self.peek(), Some(BoolToken::RParen)) {
                    bail!("missing closing `)` in boolean formula");
                }
                self.pos += 1;
                Ok(inner)
            }
            other => bail!("unexpected token `{other:?}` in boolean atom"),
        }
    }
}

fn collect_bool_vars(expr: &BoolExpr, out: &mut BTreeSet<String>) {
    match expr {
        BoolExpr::Const(_) => {}
        BoolExpr::Var(v) => {
            out.insert(v.clone());
        }
        BoolExpr::Not(a) => collect_bool_vars(a, out),
        BoolExpr::And(a, b)
        | BoolExpr::Or(a, b)
        | BoolExpr::Xor(a, b)
        | BoolExpr::Implies(a, b)
        | BoolExpr::Iff(a, b) => {
            collect_bool_vars(a, out);
            collect_bool_vars(b, out);
        }
    }
}

fn eval_bool_expr(expr: &BoolExpr, env: &HashMap<&str, bool>) -> bool {
    match expr {
        BoolExpr::Const(b) => *b,
        BoolExpr::Var(v) => *env.get(v.as_str()).unwrap_or(&false),
        BoolExpr::Not(a) => !eval_bool_expr(a, env),
        BoolExpr::And(a, b) => eval_bool_expr(a, env) && eval_bool_expr(b, env),
        BoolExpr::Or(a, b) => eval_bool_expr(a, env) || eval_bool_expr(b, env),
        BoolExpr::Xor(a, b) => eval_bool_expr(a, env) ^ eval_bool_expr(b, env),
        BoolExpr::Implies(a, b) => !eval_bool_expr(a, env) || eval_bool_expr(b, env),
        BoolExpr::Iff(a, b) => eval_bool_expr(a, env) == eval_bool_expr(b, env),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BooleanSatResult {
    pub classification: String,
    pub satisfiable: bool,
    pub tautology: bool,
    pub contradiction: bool,
    pub variables: Vec<String>,
    pub satisfying_count: usize,
    pub total_assignments: usize,
    pub witness: Option<BTreeMap<String, bool>>,
    pub counterexample: Option<BTreeMap<String, bool>>,
}

/// Exhaustively solves Boolean SAT / Tautology / Contradiction for formulas up to 12 variables.
pub fn solve_boolean_sat(formula: &str) -> Result<BooleanSatResult> {
    let ast = BoolParser::parse(formula)?;
    let mut var_set = BTreeSet::new();
    collect_bool_vars(&ast, &mut var_set);
    if var_set.len() > MAX_BOOLEAN_VARS {
        bail!(
            "boolean formula has {} variables; exact truth-table solver caps at {MAX_BOOLEAN_VARS}",
            var_set.len()
        );
    }
    let vars: Vec<String> = var_set.into_iter().collect();
    let total = 1usize << vars.len();
    let mut sat_count = 0usize;
    let mut witness: Option<BTreeMap<String, bool>> = None;
    let mut counterexample: Option<BTreeMap<String, bool>> = None;
    let mut env: HashMap<&str, bool> = HashMap::with_capacity(vars.len());

    for mask in 0..total {
        for (idx, name) in vars.iter().enumerate() {
            let bit = ((mask >> (vars.len() - 1 - idx)) & 1) == 1;
            env.insert(name.as_str(), bit);
        }
        let val = eval_bool_expr(&ast, &env);
        if val {
            sat_count += 1;
            if witness.is_none() {
                witness = Some(
                    vars.iter()
                        .map(|n| (n.clone(), env[n.as_str()]))
                        .collect(),
                );
            }
        } else if counterexample.is_none() {
            counterexample = Some(
                vars.iter()
                    .map(|n| (n.clone(), env[n.as_str()]))
                    .collect(),
            );
        }
    }

    let tautology = sat_count == total;
    let contradiction = sat_count == 0;
    let satisfiable = sat_count > 0;
    let classification = if tautology {
        "tautology"
    } else if contradiction {
        "contradiction"
    } else {
        "satisfiable"
    };

    Ok(BooleanSatResult {
        classification: classification.into(),
        satisfiable,
        tautology,
        contradiction,
        variables: vars,
        satisfying_count: sat_count,
        total_assignments: total,
        witness,
        counterexample,
    })
}

// --- 5-Field UTC Vixie Cron Validator & Next-Run Solver ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronReport {
    pub valid: bool,
    pub normalized_expression: String,
    pub next_runs_utc: Vec<String>,
}

struct CronField {
    allowed: BTreeSet<u32>,
    is_wildcard: bool,
}

fn parse_cron_atom(token: &str, min: u32, max: u32, names: &[(&str, u32)], fold_sunday: bool) -> Result<u32> {
    let upper = token.trim().to_ascii_uppercase();
    for &(label, val) in names {
        if upper == label {
            return Ok(val);
        }
    }
    let mut n = upper
        .parse::<u32>()
        .with_context(|| format!("invalid cron token `{token}`"))?;
    if fold_sunday && n == 7 {
        n = 0;
    }
    if n < min || n > max {
        bail!("cron value `{token}` out of allowed range {min}..={max}");
    }
    Ok(n)
}

fn parse_cron_field(raw: &str, min: u32, max: u32, names: &[(&str, u32)], fold_sunday: bool) -> Result<CronField> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        bail!("empty cron field");
    }
    let is_wildcard = trimmed == "*";
    let mut allowed = BTreeSet::new();

    for part in trimmed.split(',') {
        let part = part.trim();
        let (range_part, step) = if let Some((l, r)) = part.split_once('/') {
            let s = r
                .trim()
                .parse::<u32>()
                .with_context(|| format!("invalid cron step `{r}`"))?;
            if s == 0 {
                bail!("cron step must be >= 1");
            }
            (l.trim(), s)
        } else {
            (part, 1)
        };

        let (start, end) = if range_part == "*" {
            (min, max)
        } else if let Some((a, b)) = range_part.split_once('-') {
            let lo = parse_cron_atom(a, min, max, names, fold_sunday)?;
            let hi = parse_cron_atom(b, min, max, names, fold_sunday)?;
            if lo > hi {
                bail!("cron range `{range_part}` has start > end");
            }
            (lo, hi)
        } else {
            let single = parse_cron_atom(range_part, min, max, names, fold_sunday)?;
            let hi = if part.contains('/') { max } else { single };
            (single, hi)
        };

        let mut v = start;
        while v <= end {
            allowed.insert(v);
            match v.checked_add(step) {
                Some(next) => v = next,
                None => break,
            }
        }
    }

    if allowed.is_empty() {
        bail!("cron field `{raw}` matches no values");
    }
    Ok(CronField {
        allowed,
        is_wildcard,
    })
}

/// Validates a 5-field UTC Vixie Cron expression (or `@daily`/`@hourly`/etc. macro) and
/// computes the next `count` UTC firing timestamps within a 2-year horizon.
pub fn validate_and_next_cron(
    expression: &str,
    from_utc: Option<DateTime<Utc>>,
    count: usize,
) -> Result<CronReport> {
    let trimmed = expression.trim();
    let expanded = match trimmed.to_ascii_lowercase().as_str() {
        "@yearly" | "@annually" => "0 0 1 1 *",
        "@monthly" => "0 0 1 * *",
        "@weekly" => "0 0 * * 0",
        "@daily" | "@midnight" => "0 0 * * *",
        "@hourly" => "0 * * * *",
        _ => trimmed,
    };
    let parts: Vec<&str> = expanded.split_whitespace().collect();
    if parts.len() != 5 {
        bail!(
            "Vixie cron requires exactly 5 fields (`min hour dom month dow`), got {}",
            parts.len()
        );
    }

    const MONTHS: &[(&str, u32)] = &[
        ("JAN", 1),
        ("FEB", 2),
        ("MAR", 3),
        ("APR", 4),
        ("MAY", 5),
        ("JUN", 6),
        ("JUL", 7),
        ("AUG", 8),
        ("SEP", 9),
        ("OCT", 10),
        ("NOV", 11),
        ("DEC", 12),
    ];
    const DOWS: &[(&str, u32)] = &[
        ("SUN", 0),
        ("MON", 1),
        ("TUE", 2),
        ("WED", 3),
        ("THU", 4),
        ("FRI", 5),
        ("SAT", 6),
    ];

    let minutes = parse_cron_field(parts[0], 0, 59, &[], false)?;
    let hours = parse_cron_field(parts[1], 0, 23, &[], false)?;
    let doms = parse_cron_field(parts[2], 1, 31, &[], false)?;
    let months = parse_cron_field(parts[3], 1, 12, MONTHS, false)?;
    let dows = parse_cron_field(parts[4], 0, 6, DOWS, true)?;

    let want = count.clamp(1, 20);
    let base = from_utc.unwrap_or_else(Utc::now);
    // Start strictly at the next whole minute after `base`.
    let mut cursor = Utc
        .with_ymd_and_hms(
            base.year(),
            base.month(),
            base.day(),
            base.hour(),
            base.minute(),
            0,
        )
        .single()
        .context("valid UTC base timestamp")?
        + ChronoDuration::minutes(1);
    let horizon = cursor + ChronoDuration::days(732);

    let mut runs = Vec::with_capacity(want);
    while runs.len() < want && cursor <= horizon {
        if !months.allowed.contains(&cursor.month()) {
            let (ny, nm) = if cursor.month() == 12 {
                (cursor.year() + 1, 1)
            } else {
                (cursor.year(), cursor.month() + 1)
            };
            cursor = Utc
                .with_ymd_and_hms(ny, nm, 1, 0, 0, 0)
                .single()
                .context("next month UTC")?;
            continue;
        }
        let dom_match = doms.allowed.contains(&cursor.day());
        let dow_num = cursor.weekday().num_days_from_sunday();
        let dow_match = dows.allowed.contains(&dow_num);
        // Vixie cron semantics: OR when both DOM and DOW are restricted, AND when either is `*`.
        let day_ok = if !doms.is_wildcard && !dows.is_wildcard {
            dom_match || dow_match
        } else {
            dom_match && dow_match
        };
        if !day_ok {
            cursor = (cursor + ChronoDuration::days(1))
                .date_naive()
                .and_hms_opt(0, 0, 0)
                .map(|ndt| Utc.from_utc_datetime(&ndt))
                .context("next day UTC")?;
            continue;
        }
        if !hours.allowed.contains(&cursor.hour()) {
            cursor = (cursor + ChronoDuration::hours(1))
                .with_minute(0)
                .and_then(|dt| dt.with_second(0))
                .context("next hour UTC")?;
            continue;
        }
        if !minutes.allowed.contains(&cursor.minute()) {
            cursor += ChronoDuration::minutes(1);
            continue;
        }
        runs.push(cursor.to_rfc3339());
        cursor += ChronoDuration::minutes(1);
    }

    Ok(CronReport {
        valid: true,
        normalized_expression: parts.join(" "),
        next_runs_utc: runs,
    })
}

// ============================================================================
// 4. Rust-Lifetime-Aware Multi-Language Syntax Balance Checker
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceDiagnostic {
    pub kind: String,
    pub message: String,
    pub line: usize,
    pub col: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxBalanceReport {
    pub balanced: bool,
    pub language: String,
    pub errors: Vec<BalanceDiagnostic>,
    pub checked_lines: usize,
}

fn is_ident_continue(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Checks delimiter and literal balance (`()`, `[]`, `{}`, strings, comments) across
/// `rust | ts | js | python | json | sql` with full Rust lifetime (`'a`, `'static`, `'_`)
/// and Rust raw-string (`r#"..."#`) awareness so lifetimes never trigger false positives.
#[must_use]
pub fn check_syntax_balance(language: &str, code: &str) -> SyntaxBalanceReport {
    let lang = language.trim().to_ascii_lowercase();
    let is_rust = matches!(lang.as_str(), "rs" | "rust");
    let is_py = matches!(lang.as_str(), "py" | "python");
    let is_sql = lang == "sql";
    let is_js_ts = matches!(lang.as_str(), "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs");
    let is_json = lang == "json";

    let chars: Vec<char> = code.chars().collect();
    let n = chars.len();
    let mut i = 0usize;
    let mut line = 1usize;
    let mut col = 1usize;
    let mut stack: Vec<(char, usize, usize)> = Vec::new();
    let mut errors: Vec<BalanceDiagnostic> = Vec::new();

    let advance = |idx: &mut usize, ln: &mut usize, cl: &mut usize| {
        if chars[*idx] == '\n' {
            *ln += 1;
            *cl = 1;
        } else {
            *cl += 1;
        }
        *idx += 1;
    };

    while i < n {
        let ch = chars[i];

        // Line comments
        if (!is_py && !is_sql && !is_json && ch == '/' && i + 1 < n && chars[i + 1] == '/')
            || (is_py && ch == '#')
            || (is_sql && ch == '-' && i + 1 < n && chars[i + 1] == '-')
        {
            while i < n && chars[i] != '\n' {
                advance(&mut i, &mut line, &mut col);
            }
            continue;
        }

        // Block comments (`/* ... */`, nested in Rust)
        if !is_py && !is_json && ch == '/' && i + 1 < n && chars[i + 1] == '*' {
            let start_ln = line;
            let start_cl = col;
            advance(&mut i, &mut line, &mut col);
            advance(&mut i, &mut line, &mut col);
            let mut depth = 1usize;
            while i < n && depth > 0 {
                if is_rust && chars[i] == '/' && i + 1 < n && chars[i + 1] == '*' {
                    depth += 1;
                    advance(&mut i, &mut line, &mut col);
                    advance(&mut i, &mut line, &mut col);
                } else if chars[i] == '*' && i + 1 < n && chars[i + 1] == '/' {
                    depth -= 1;
                    advance(&mut i, &mut line, &mut col);
                    advance(&mut i, &mut line, &mut col);
                } else {
                    advance(&mut i, &mut line, &mut col);
                }
            }
            if depth > 0 {
                errors.push(BalanceDiagnostic {
                    kind: "unclosed_comment".into(),
                    message: "unclosed block comment `/*`".into(),
                    line: start_ln,
                    col: start_cl,
                });
            }
            continue;
        }

        // Rust raw strings: `r"..."`, `r#"..."#`, `br#"..."#`
        if is_rust && (ch == 'r' || (ch == 'b' && i + 1 < n && chars[i + 1] == 'r')) {
            let r_pos = if ch == 'b' { i + 1 } else { i };
            let prev_ok = i == 0 || !is_ident_continue(chars[i - 1]);
            if prev_ok {
                let mut k = r_pos + 1;
                let mut hashes = 0usize;
                while k < n && chars[k] == '#' {
                    hashes += 1;
                    k += 1;
                }
                if k < n && chars[k] == '"' {
                    let start_ln = line;
                    let start_cl = col;
                    while i <= k {
                        advance(&mut i, &mut line, &mut col);
                    }
                    let mut closed = false;
                    while i < n {
                        if chars[i] == '"' {
                            let mut matched = 0usize;
                            while matched < hashes && i + 1 + matched < n && chars[i + 1 + matched] == '#' {
                                matched += 1;
                            }
                            if matched == hashes {
                                for _ in 0..=(hashes) {
                                    advance(&mut i, &mut line, &mut col);
                                }
                                closed = true;
                                break;
                            }
                        }
                        advance(&mut i, &mut line, &mut col);
                    }
                    if !closed {
                        errors.push(BalanceDiagnostic {
                            kind: "unclosed_string".into(),
                            message: "unclosed Rust raw string literal".into(),
                            line: start_ln,
                            col: start_cl,
                        });
                    }
                    continue;
                }
            }
        }

        // Python triple-quoted strings (`"""` or `'''`)
        if is_py
            && (ch == '"' || ch == '\'')
            && i + 2 < n
            && chars[i + 1] == ch
            && chars[i + 2] == ch
        {
            let quote = ch;
            let start_ln = line;
            let start_cl = col;
            for _ in 0..3 {
                advance(&mut i, &mut line, &mut col);
            }
            let mut closed = false;
            while i < n {
                if chars[i] == '\\' && i + 1 < n {
                    advance(&mut i, &mut line, &mut col);
                    advance(&mut i, &mut line, &mut col);
                    continue;
                }
                if chars[i] == quote
                    && i + 2 < n
                    && chars[i + 1] == quote
                    && chars[i + 2] == quote
                {
                    for _ in 0..3 {
                        advance(&mut i, &mut line, &mut col);
                    }
                    closed = true;
                    break;
                }
                advance(&mut i, &mut line, &mut col);
            }
            if !closed {
                errors.push(BalanceDiagnostic {
                    kind: "unclosed_string".into(),
                    message: format!("unclosed triple-quoted string `{quote}{quote}{quote}`"),
                    line: start_ln,
                    col: start_cl,
                });
            }
            continue;
        }

        // Double-quoted strings
        if ch == '"' {
            let start_ln = line;
            let start_cl = col;
            advance(&mut i, &mut line, &mut col);
            let mut closed = false;
            while i < n {
                if chars[i] == '\\' && i + 1 < n {
                    advance(&mut i, &mut line, &mut col);
                    advance(&mut i, &mut line, &mut col);
                    continue;
                }
                if chars[i] == '"' {
                    advance(&mut i, &mut line, &mut col);
                    closed = true;
                    break;
                }
                if is_json && chars[i] == '\n' {
                    break;
                }
                advance(&mut i, &mut line, &mut col);
            }
            if !closed {
                errors.push(BalanceDiagnostic {
                    kind: "unclosed_string".into(),
                    message: "unclosed double-quoted string `\"`".into(),
                    line: start_ln,
                    col: start_cl,
                });
            }
            continue;
        }

        // JS/TS template literals
        if is_js_ts && ch == '`' {
            let start_ln = line;
            let start_cl = col;
            advance(&mut i, &mut line, &mut col);
            let mut closed = false;
            while i < n {
                if chars[i] == '\\' && i + 1 < n {
                    advance(&mut i, &mut line, &mut col);
                    advance(&mut i, &mut line, &mut col);
                    continue;
                }
                if chars[i] == '`' {
                    advance(&mut i, &mut line, &mut col);
                    closed = true;
                    break;
                }
                advance(&mut i, &mut line, &mut col);
            }
            if !closed {
                errors.push(BalanceDiagnostic {
                    kind: "unclosed_string".into(),
                    message: "unclosed template literal `` ` ``".into(),
                    line: start_ln,
                    col: start_cl,
                });
            }
            continue;
        }

        // Single quotes: Rust lifetimes (`'a`, `'static`, `'_`) vs char literals vs single-quoted strings
        if ch == '\'' {
            if is_rust {
                // Case A: escaped char literal (`'\n'`, `'\''`, `'\u{1F600}'`, `'\x7f'`)
                if i + 1 < n && chars[i + 1] == '\\' {
                    let start_ln = line;
                    let start_cl = col;
                    advance(&mut i, &mut line, &mut col);
                    advance(&mut i, &mut line, &mut col);
                    if i < n {
                        advance(&mut i, &mut line, &mut col);
                    }
                    let mut closed = false;
                    let mut steps = 0usize;
                    while i < n && steps < 12 && chars[i] != '\n' {
                        if chars[i] == '\'' {
                            advance(&mut i, &mut line, &mut col);
                            closed = true;
                            break;
                        }
                        advance(&mut i, &mut line, &mut col);
                        steps += 1;
                    }
                    if !closed {
                        errors.push(BalanceDiagnostic {
                            kind: "unclosed_char".into(),
                            message: "unclosed escaped Rust char literal".into(),
                            line: start_ln,
                            col: start_cl,
                        });
                    }
                    continue;
                }
                // Case B: single-character literal (`'x'`)
                if i + 2 < n && chars[i + 1] != '\'' && chars[i + 1] != '\n' && chars[i + 2] == '\''
                {
                    advance(&mut i, &mut line, &mut col);
                    advance(&mut i, &mut line, &mut col);
                    advance(&mut i, &mut line, &mut col);
                    continue;
                }
                // Case C: Rust lifetime or loop label (`'a`, `'static`, `'_`, `'outer:`)
                if i + 1 < n && (chars[i + 1].is_ascii_alphabetic() || chars[i + 1] == '_') {
                    advance(&mut i, &mut line, &mut col);
                    while i < n && is_ident_continue(chars[i]) {
                        advance(&mut i, &mut line, &mut col);
                    }
                    continue;
                }
                errors.push(BalanceDiagnostic {
                    kind: "unclosed_char".into(),
                    message: "stray single quote `'` in Rust source".into(),
                    line,
                    col,
                });
                advance(&mut i, &mut line, &mut col);
                continue;
            } else if !is_json {
                let start_ln = line;
                let start_cl = col;
                advance(&mut i, &mut line, &mut col);
                let mut closed = false;
                while i < n {
                    if !is_sql && chars[i] == '\\' && i + 1 < n {
                        advance(&mut i, &mut line, &mut col);
                        advance(&mut i, &mut line, &mut col);
                        continue;
                    }
                    if is_sql && chars[i] == '\'' && i + 1 < n && chars[i + 1] == '\'' {
                        advance(&mut i, &mut line, &mut col);
                        advance(&mut i, &mut line, &mut col);
                        continue;
                    }
                    if chars[i] == '\'' {
                        advance(&mut i, &mut line, &mut col);
                        closed = true;
                        break;
                    }
                    advance(&mut i, &mut line, &mut col);
                }
                if !closed {
                    errors.push(BalanceDiagnostic {
                        kind: "unclosed_string".into(),
                        message: "unclosed single-quoted string `'`".into(),
                        line: start_ln,
                        col: start_cl,
                    });
                }
                continue;
            }
        }

        // Delimiters
        match ch {
            '(' | '[' | '{' => {
                stack.push((ch, line, col));
                advance(&mut i, &mut line, &mut col);
            }
            ')' | ']' | '}' => {
                let expected = match ch {
                    ')' => '(',
                    ']' => '[',
                    _ => '{',
                };
                match stack.pop() {
                    Some((open, _, _)) if open == expected => {}
                    Some((open, open_ln, open_cl)) => {
                        errors.push(BalanceDiagnostic {
                            kind: "mismatched_delimiter".into(),
                            message: format!(
                                "mismatched `{ch}` (expected closing for `{open}` opened at L{open_ln}:{open_cl})"
                            ),
                            line,
                            col,
                        });
                    }
                    None => {
                        errors.push(BalanceDiagnostic {
                            kind: "unexpected_closer".into(),
                            message: format!("unexpected closing delimiter `{ch}` with no matching opener"),
                            line,
                            col,
                        });
                    }
                }
                advance(&mut i, &mut line, &mut col);
            }
            _ => advance(&mut i, &mut line, &mut col),
        }
    }

    for (open, open_ln, open_cl) in stack {
        errors.push(BalanceDiagnostic {
            kind: "unclosed_delimiter".into(),
            message: format!("unclosed delimiter `{open}`"),
            line: open_ln,
            col: open_cl,
        });
    }

    SyntaxBalanceReport {
        balanced: errors.is_empty(),
        language: if lang.is_empty() { "generic".into() } else { lang },
        errors,
        checked_lines: line,
    }
}

// ============================================================================
// 5. Deterministic Numeric & Citation Claim Verifier
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimSource {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimIssue {
    pub kind: String,
    pub claim: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimVerificationReport {
    /// One of `"verified"`, `"needs-citation"`, `"abstain-recommended"`, `"math-discrepancy-detected"`.
    /// NEVER `"verified"` when `claims_checked == 0`.
    pub verdict: String,
    /// Epistemic confidence score strictly capped at `<= 0.75`.
    pub epistemic_score: f64,
    pub claims_checked: usize,
    pub claims_verified: usize,
    pub math_checked: usize,
    pub math_discrepancies: usize,
    pub citations_checked: usize,
    pub unsupported_citations: usize,
    pub issues: Vec<ClaimIssue>,
}

/// Deterministically verifies inline arithmetic claims (`expr = value`) and `[path:line]` /
/// `[S#]` / quoted source citations against `sources`. Never emits `"verified"` on 0 claims
/// and strictly caps `epistemic_score <= 0.75`.
#[must_use]
pub fn verify_claims(draft: &str, sources: &[ClaimSource]) -> ClaimVerificationReport {
    let mut issues = Vec::new();
    let mut math_checked = 0usize;
    let mut math_discrepancies = 0usize;
    let mut citations_checked = 0usize;
    let mut unsupported_citations = 0usize;
    let mut verified_count = 0usize;

    let empty_vars = HashMap::new();

    // 1. Verify inline arithmetic claims shaped like `<expr> = <number>` (ignoring `==`, `!=`, `<=`, `>=`).
    if let Ok(eq_re) = regex::Regex::new(
        r"(?m)(?:^|[\s(])([0-9][0-9\s+\-*/%^().]*[+\-*/%^][0-9\s+\-*/%^().]*)\s*=\s*(-?[0-9]+(?:\.[0-9]+)?)(?:\b|$)",
    ) {
        for cap in eq_re.captures_iter(draft) {
            let lhs_raw = cap[1].trim();
            let rhs_raw = cap[2].trim();
            if let (Ok(lhs_val), Ok(rhs_val)) = (
                eval_math_expr(lhs_raw, &empty_vars),
                rhs_raw.parse::<f64>(),
            ) {
                math_checked += 1;
                let tol = 1e-4_f64.max(rhs_val.abs() * 1e-3);
                if (lhs_val - rhs_val).abs() <= tol {
                    verified_count += 1;
                } else {
                    math_discrepancies += 1;
                    issues.push(ClaimIssue {
                        kind: "math_discrepancy".into(),
                        claim: format!("{lhs_raw} = {rhs_raw}"),
                        detail: format!("deterministic AST evaluation produced {lhs_val:.6}"),
                    });
                }
            }
        }
    }

    // 2. Verify `[path:line]` or `[path:start-end]` citations against supplied sources.
    if let Ok(file_cite_re) =
        regex::Regex::new(r"\[([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?\]")
    {
        for cap in file_cite_re.captures_iter(draft) {
            citations_checked += 1;
            let raw_path = cap[1].replace('\\', "/");
            let start_line: usize = cap[2].parse().unwrap_or(0);
            let end_line: usize = cap
                .get(3)
                .and_then(|m| m.as_str().parse().ok())
                .unwrap_or(start_line);

            let matched_src = sources.iter().find(|s| {
                let sp = s.path.replace('\\', "/");
                sp == raw_path || sp.ends_with(&format!("/{raw_path}"))
            });
            match matched_src {
                Some(src) => {
                    let line_count = src.content.lines().count().max(1);
                    if start_line >= 1 && end_line >= start_line && end_line <= line_count {
                        verified_count += 1;
                    } else {
                        unsupported_citations += 1;
                        issues.push(ClaimIssue {
                            kind: "line_out_of_range".into(),
                            claim: cap[0].to_owned(),
                            detail: format!(
                                "source `{}` has only {line_count} line(s)",
                                src.path
                            ),
                        });
                    }
                }
                None => {
                    unsupported_citations += 1;
                    issues.push(ClaimIssue {
                        kind: "missing_source_file".into(),
                        claim: cap[0].to_owned(),
                        detail: "cited file was not found in provided verification sources".into(),
                    });
                }
            }
        }
    }

    // 3. Verify `[S1]` / `[G1]` source-ID citations against provided source IDs.
    if let Ok(id_cite_re) = regex::Regex::new(r"\[([SG]\d+)\]") {
        for cap in id_cite_re.captures_iter(draft) {
            citations_checked += 1;
            let id = &cap[1];
            if sources.iter().any(|s| s.id.eq_ignore_ascii_case(id)) {
                verified_count += 1;
            } else {
                unsupported_citations += 1;
                issues.push(ClaimIssue {
                    kind: "unknown_source_id".into(),
                    claim: cap[0].to_owned(),
                    detail: format!("source id `{id}` does not exist in provided sources"),
                });
            }
        }
    }

    let claims_checked = math_checked + citations_checked;
    let (verdict, raw_score) = if math_discrepancies > 0 {
        (
            "math-discrepancy-detected",
            (0.25 * (verified_count as f64 / claims_checked.max(1) as f64)).clamp(0.0, 0.35),
        )
    } else if unsupported_citations > 0 {
        (
            "abstain-recommended",
            (0.40 * (verified_count as f64 / claims_checked.max(1) as f64)).clamp(0.0, 0.40),
        )
    } else if claims_checked == 0 {
        // Strict anti-hallucination invariant: NEVER emit "verified" when 0 claims were checked!
        if sources.is_empty() {
            ("abstain-recommended", 0.35)
        } else {
            ("needs-citation", 0.50)
        }
    } else {
        ("verified", MAX_EPISTEMIC_SCORE)
    };

    ClaimVerificationReport {
        verdict: verdict.to_owned(),
        epistemic_score: raw_score.min(MAX_EPISTEMIC_SCORE),
        claims_checked,
        claims_verified: verified_count,
        math_checked,
        math_discrepancies,
        citations_checked,
        unsupported_citations,
        issues,
    }
}

// ============================================================================
// 6. Deferred Tool Spec & JSON Dispatcher (`stem_verify`)
// ============================================================================

/// Returns the `ToolSpec` registered in `DeferredToolRegistry` (keeping Token-0 prefix invariant).
#[must_use]
pub fn stem_verify_tool_spec() -> ToolSpec {
    ToolSpec {
        name: "stem_verify".into(),
        description: "Zero-eval pure-Rust STEM & anti-hallucination verifier: AST math calculator (`calc`), static ReDoS analyzer (`redos`), Newton-Bisection root finder (`root`), RK4 ODE solver (`ode`), Gauss-Jordan matrix RREF/det/inverse/rank/trace (`matrix`), Boolean SAT/tautology (`sat`), UTC Vixie Cron next-run (`cron`), Rust-lifetime-aware syntax balance (`syntax`), and deterministic numeric/citation claim verification (`verify_claims`).".into(),
        parameters: json!({
            "type": "object",
            "properties": {
                "mode": {
                    "type": "string",
                    "enum": ["calc", "redos", "root", "ode", "matrix", "sat", "cron", "syntax", "verify_claims"]
                },
                "expression": { "type": "string" },
                "variables": { "type": "object" },
                "pattern": { "type": "string" },
                "var": { "type": "string" },
                "a": { "type": "number" },
                "b": { "type": "number" },
                "tol": { "type": "number" },
                "max_iter": { "type": "integer" },
                "t0": { "type": "number" },
                "y0": { "type": "number" },
                "t_end": { "type": "number" },
                "steps": { "type": "integer" },
                "matrix": { "type": "array" },
                "rhs": { "type": "array" },
                "formula": { "type": "string" },
                "from_utc": { "type": "string" },
                "count": { "type": "integer" },
                "language": { "type": "string" },
                "code": { "type": "string" },
                "draft": { "type": "string" },
                "sources": { "type": "array" }
            },
            "required": ["mode"]
        }),
        read_only: true,
    }
}

/// Executes a `stem_verify` tool call and returns pretty JSON output.
pub fn dispatch_stem_verify(args: &Value) -> Result<String> {
    let mode = args
        .get("mode")
        .or_else(|| args.get("action"))
        .and_then(Value::as_str)
        .context("stem_verify requires string parameter 'mode'")?
        .trim()
        .to_ascii_lowercase();

    let out = match mode.as_str() {
        "calc" | "math" => {
            let expr = args
                .get("expression")
                .or_else(|| args.get("expr"))
                .and_then(Value::as_str)
                .context("stem_verify calc requires 'expression'")?;
            let mut vars = HashMap::new();
            if let Some(obj) = args.get("variables").and_then(Value::as_object) {
                for (k, v) in obj {
                    if let Some(num) = v.as_f64() {
                        vars.insert(k.clone(), num);
                    }
                }
            }
            let value = eval_math_expr(expr, &vars)?;
            json!({ "ok": true, "mode": "calc", "expression": expr, "value": value })
        }
        "redos" => {
            let pattern = args
                .get("pattern")
                .or_else(|| args.get("expression"))
                .and_then(Value::as_str)
                .context("stem_verify redos requires 'pattern'")?;
            let report = analyze_redos(pattern);
            serde_json::to_value(report)?
        }
        "root" => {
            let expr = args
                .get("expression")
                .or_else(|| args.get("expr"))
                .and_then(Value::as_str)
                .context("stem_verify root requires 'expression'")?;
            let var = args.get("var").and_then(Value::as_str).unwrap_or("x");
            let a = args.get("a").and_then(Value::as_f64).context("root requires numeric 'a'")?;
            let b = args.get("b").and_then(Value::as_f64).context("root requires numeric 'b'")?;
            let tol = args.get("tol").and_then(Value::as_f64).unwrap_or(1e-10);
            let max_iter = args.get("max_iter").and_then(Value::as_u64).unwrap_or(100) as usize;
            serde_json::to_value(solve_root(expr, var, a, b, tol, max_iter)?)?
        }
        "ode" | "rk4" => {
            let expr = args
                .get("expression")
                .or_else(|| args.get("expr"))
                .and_then(Value::as_str)
                .context("stem_verify ode requires 'expression' for dy/dt = f(t, y)")?;
            let t0 = args.get("t0").and_then(Value::as_f64).unwrap_or(0.0);
            let y0 = args.get("y0").and_then(Value::as_f64).context("ode requires numeric 'y0'")?;
            let t_end = args
                .get("t_end")
                .and_then(Value::as_f64)
                .context("ode requires numeric 't_end'")?;
            let steps = args.get("steps").and_then(Value::as_u64).unwrap_or(200) as usize;
            serde_json::to_value(solve_ode_rk4(expr, t0, y0, t_end, steps)?)?
        }
        "matrix" => {
            let rows_val = args
                .get("matrix")
                .and_then(Value::as_array)
                .context("stem_verify matrix requires 2D array 'matrix'")?;
            let mut matrix = Vec::with_capacity(rows_val.len());
            for row in rows_val {
                let arr = row
                    .as_array()
                    .context("matrix rows must be arrays of numbers")?;
                let mut parsed_row = Vec::with_capacity(arr.len());
                for cell in arr {
                    parsed_row.push(cell.as_f64().context("matrix entries must be numbers")?);
                }
                matrix.push(parsed_row);
            }
            let rhs: Option<Vec<f64>> = args
                .get("rhs")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .map(|v| v.as_f64().context("rhs entries must be numbers"))
                        .collect::<Result<Vec<_>>>()
                })
                .transpose()?;
            serde_json::to_value(solve_matrix(&matrix, rhs.as_deref())?)?
        }
        "sat" | "boolean" => {
            let formula = args
                .get("formula")
                .or_else(|| args.get("expression"))
                .and_then(Value::as_str)
                .context("stem_verify sat requires 'formula'")?;
            serde_json::to_value(solve_boolean_sat(formula)?)?
        }
        "cron" => {
            let expr = args
                .get("expression")
                .or_else(|| args.get("cron"))
                .and_then(Value::as_str)
                .context("stem_verify cron requires 'expression'")?;
            let from_utc = args
                .get("from_utc")
                .and_then(Value::as_str)
                .map(|s| DateTime::parse_from_rfc3339(s).map(|dt| dt.with_timezone(&Utc)))
                .transpose()
                .context("invalid RFC3339 'from_utc'")?;
            let count = args.get("count").and_then(Value::as_u64).unwrap_or(5) as usize;
            serde_json::to_value(validate_and_next_cron(expr, from_utc, count)?)?
        }
        "syntax" | "balance" => {
            let language = args
                .get("language")
                .or_else(|| args.get("lang"))
                .and_then(Value::as_str)
                .unwrap_or("rust");
            let code = args
                .get("code")
                .and_then(Value::as_str)
                .context("stem_verify syntax requires 'code'")?;
            serde_json::to_value(check_syntax_balance(language, code))?
        }
        "verify_claims" | "claims" => {
            let draft = args
                .get("draft")
                .or_else(|| args.get("text"))
                .and_then(Value::as_str)
                .context("stem_verify verify_claims requires 'draft'")?;
            let sources: Vec<ClaimSource> = args
                .get("sources")
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .context("invalid 'sources' array")?
                .unwrap_or_default();
            serde_json::to_value(verify_claims(draft, &sources))?
        }
        other => bail!("unsupported stem_verify mode `{other}`"),
    };

    Ok(serde_json::to_string_pretty(&out)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ast_calculator_evaluates_precedence_functions_and_enforces_depth_cap() {
        let empty = HashMap::new();
        assert!((eval_math_expr("2 + 3 * 4^2", &empty).unwrap() - 50.0).abs() < 1e-12);
        assert!((eval_math_expr("2^3^2", &empty).unwrap() - 512.0).abs() < 1e-12);
        assert!((eval_math_expr("5! + ncr(6, 2)", &empty).unwrap() - 135.0).abs() < 1e-12);
        assert!((eval_math_expr("sin(pi / 2) + ln(e)", &empty).unwrap() - 2.0).abs() < 1e-12);

        let deeply_nested = format!("{}1{}", "(".repeat(MAX_AST_DEPTH + 10), ")".repeat(MAX_AST_DEPTH + 10));
        let err = eval_math_expr(&deeply_nested, &empty).unwrap_err();
        assert!(err.to_string().contains("maximum AST depth"));
    }

    #[test]
    fn redos_analyzer_flags_catastrophic_patterns_and_accepts_safe_ones() {
        assert!(has_unsafe_redos_construct("(a+)+"));
        assert!(has_unsafe_redos_construct("((a+))+"));
        assert!(has_unsafe_redos_construct("(a|a)+"));
        assert!(has_unsafe_redos_construct("(a|ab)+"));
        assert!(has_unsafe_redos_construct(".*.*foo"));
        assert!(!has_unsafe_redos_construct(r"^[a-z0-9_-]{3,32}$"));
        assert!(!has_unsafe_redos_construct(r"\d{4}-\d{2}-\d{2}"));
    }

    #[test]
    fn numerical_solvers_root_rk4_matrix_sat_and_cron_match_analytical_values() {
        // Root of x^2 - 2 = 0 on [1, 2] -> sqrt(2)
        let root = solve_root("x^2 - 2", "x", 1.0, 2.0, 1e-12, 50).unwrap();
        assert!(root.converged);
        assert!((root.root - std::f64::consts::SQRT_2).abs() < 1e-10);

        // RK4 for dy/dt = y, y(0) = 1 at t = 1 -> e
        let ode = solve_ode_rk4("y", 0.0, 1.0, 1.0, 200).unwrap();
        assert!((ode.y_final - std::f64::consts::E).abs() < 1e-8);

        // Matrix RREF / Det / Inverse / Ax = b
        let m = vec![vec![2.0, 1.0], vec![5.0, 3.0]];
        let mat = solve_matrix(&m, Some(&[4.0, 11.0])).unwrap();
        assert_eq!(mat.rank, 2);
        assert!((mat.determinant.unwrap() - 1.0).abs() < 1e-10);
        assert!((mat.trace.unwrap() - 5.0).abs() < 1e-10);
        let sol = mat.solution.unwrap();
        assert!((sol[0] - 1.0).abs() < 1e-10 && (sol[1] - 2.0).abs() < 1e-10);

        // Boolean SAT: Excluded middle is tautology; contradiction is unsat
        let taut = solve_boolean_sat("p OR NOT p").unwrap();
        assert!(taut.tautology && taut.classification == "tautology");
        let contra = solve_boolean_sat("p AND NOT p").unwrap();
        assert!(contra.contradiction && !contra.satisfiable);
        let sat = solve_boolean_sat("(a -> b) AND a AND NOT c").unwrap();
        assert_eq!(sat.classification, "satisfiable");
        assert!(sat.witness.unwrap()["b"]);

        // 5-field UTC Vixie Cron
        let base = Utc.with_ymd_and_hms(2026, 11, 28, 10, 0, 0).unwrap();
        let cron = validate_and_next_cron("15 10 * * *", Some(base), 2).unwrap();
        assert!(cron.valid);
        assert_eq!(cron.next_runs_utc.len(), 2);
        assert!(cron.next_runs_utc[0].starts_with("2026-11-28T10:15:00"));
        assert!(cron.next_runs_utc[1].starts_with("2026-11-29T10:15:00"));
    }

    #[test]
    fn syntax_balance_respects_rust_lifetimes_and_catches_real_mismatches() {
        let rust_ok = r##"
            fn borrow<'a, 'b: 'a>(x: &'a str, _c: char) -> &'static str {
                let _raw = r#"unbalanced ( [ { inside raw string"#;
                let _ch = '\'';
                /* nested /* comment ( */ */
                let _ = x;
                "ok"
            }
        "##;
        let ok_rep = check_syntax_balance("rust", rust_ok);
        assert!(ok_rep.balanced, "unexpected errors: {:?}", ok_rep.errors);

        let rust_bad = "fn broken<'a>(x: &'a str) { let v = [1, 2; }";
        let bad_rep = check_syntax_balance("rust", rust_bad);
        assert!(!bad_rep.balanced);
        assert!(!bad_rep.errors.is_empty());
    }

    #[test]
    fn claim_verifier_never_reports_verified_on_zero_claims_and_caps_epistemic_score() {
        let sources = vec![ClaimSource {
            id: "S1".into(),
            path: "src/lib.rs".into(),
            content: "fn alpha() {}\nfn beta() {}\nfn gamma() {}\n".into(),
        }];

        // Zero claims -> NEVER "verified", epistemic score <= 0.75
        let zero = verify_claims("The implementation looks clean overall.", &sources);
        assert_ne!(zero.verdict, "verified");
        assert_eq!(zero.claims_checked, 0);
        assert!(zero.epistemic_score <= MAX_EPISTEMIC_SCORE);

        // Verified math + valid citation -> "verified", score capped <= 0.75
        let ok = verify_claims("Total 12 * 4 = 48 per [src/lib.rs:2] and [S1].", &sources);
        assert_eq!(ok.verdict, "verified");
        assert_eq!(ok.claims_checked, 3);
        assert!(ok.epistemic_score <= MAX_EPISTEMIC_SCORE);

        // Arithmetic discrepancy -> "math-discrepancy-detected"
        let bad = verify_claims("We computed 12 * 4 = 50 in [src/lib.rs:2].", &sources);
        assert_eq!(bad.verdict, "math-discrepancy-detected");
        assert_eq!(bad.math_discrepancies, 1);
    }
}
