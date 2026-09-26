use crate::changes::{CandidateOutcome, SourceContext};
use crate::environment::{EnvironmentActivate, EnvironmentResult};
use crate::files::{FilesOperation, FilesResult};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::Rng;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

pub const TERMINAL_VERSION: u8 = 1;
pub const TERMINAL_HEADER_BYTES: usize = 50;
pub const TERMINAL_MAX_FRAME_BYTES: usize = 65_536;
pub const TERMINAL_MAX_PAYLOAD_BYTES: usize = 65_486;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct TerminalGeneration([u8; 16]);

impl TerminalGeneration {
    pub fn random() -> Self {
        loop {
            let mut bytes = [0_u8; 16];
            rand::rng().fill(&mut bytes);
            if bytes.iter().any(|byte| *byte != 0) {
                return Self(bytes);
            }
        }
    }

    pub fn bytes(self) -> [u8; 16] {
        self.0
    }
}

impl Serialize for TerminalGeneration {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&URL_SAFE_NO_PAD.encode(self.0))
    }
}

impl<'de> Deserialize<'de> for TerminalGeneration {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let encoded = String::deserialize(deserializer)?;
        if encoded.len() != 22 {
            return Err(serde::de::Error::custom("invalid generation"));
        }
        let decoded = URL_SAFE_NO_PAD
            .decode(&encoded)
            .map_err(|_| serde::de::Error::custom("invalid generation"))?;
        let bytes: [u8; 16] = decoded
            .try_into()
            .map_err(|_| serde::de::Error::custom("invalid generation"))?;
        if bytes.iter().all(|byte| *byte == 0) || URL_SAFE_NO_PAD.encode(bytes) != encoded {
            return Err(serde::de::Error::custom("invalid generation"));
        }
        Ok(Self(bytes))
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct U64String(#[serde(with = "u64_string")] pub u64);

mod u64_string {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(value: &u64, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<u64, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        if value.is_empty()
            || (value.len() > 1 && value.starts_with('0'))
            || !value.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(serde::de::Error::custom("invalid u64"));
        }
        value
            .parse()
            .map_err(|_| serde::de::Error::custom("invalid u64"))
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Dimensions {
    pub columns: u16,
    pub rows: u16,
}

impl Dimensions {
    pub const INITIAL: Self = Self {
        columns: 80,
        rows: 20,
    };

    pub fn valid(self) -> bool {
        (1..=1_000).contains(&self.columns) && (1..=1_000).contains(&self.rows)
    }
}

#[derive(Serialize)]
pub struct TerminalCapability {
    pub version: u8,
}

#[derive(Serialize)]
pub struct WorkloadIdentityCapability {
    pub version: u8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub terminal: TerminalCapability,
    pub workload_identity: WorkloadIdentityCapability,
}

impl Capabilities {
    pub fn current() -> Self {
        Self {
            terminal: TerminalCapability {
                version: TERMINAL_VERSION,
            },
            workload_identity: WorkloadIdentityCapability { version: 1 },
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkloadIdentityRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audience: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttl_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload_base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

impl WorkloadIdentityRequest {
    pub fn valid(&self) -> bool {
        match self.kind.as_deref() {
            None => self.audience.as_ref().is_some_and(|audience| {
                !audience.is_empty()
                    && audience.len() <= 256
                    && audience.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
                    && self
                        .ttl_seconds
                        .is_none_or(|ttl| (60..=3_600).contains(&ttl))
            }),
            Some("git-sign") => {
                self.audience.is_none()
                    && self.ttl_seconds.is_none()
                    && self.payload_base64.as_ref().is_some_and(|payload| {
                        !payload.is_empty()
                            && payload.len() <= 65_536
                            && payload.bytes().all(|byte| {
                                byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')
                            })
                    })
                    && self.protocol.is_none()
                    && self.host.is_none()
                    && self.path.is_none()
            }
            Some("git-credential") => {
                self.audience.is_none()
                    && self.ttl_seconds.is_none()
                    && self.payload_base64.is_none()
                    && self.protocol.as_deref() == Some("https")
                    && self.host.as_ref().is_some_and(|host| {
                        let (hostname, port) = host
                            .split_once(':')
                            .map_or((host.as_str(), None), |(hostname, port)| {
                                (hostname, Some(port))
                            });
                        !hostname.is_empty()
                            && host.len() <= 255
                            && hostname.bytes().all(|byte| {
                                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-')
                            })
                            && port.is_none_or(|port| {
                                !port.is_empty()
                                    && port.len() <= 5
                                    && port.bytes().all(|byte| byte.is_ascii_digit())
                            })
                    })
                    && self.path.as_ref().is_some_and(|path| {
                        !path.is_empty()
                            && path.len() <= 512
                            && path.bytes().all(|byte| {
                                byte.is_ascii_alphanumeric()
                                    || matches!(byte, b'.' | b'_' | b'/' | b'-')
                            })
                    })
            }
            Some(_) => false,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorkloadIdentityResult {
    Issued { token: String, expires_at: u64 },
    Signed { signature: String },
    Credential { username: String, password: String },
    Unauthorized,
    Unavailable,
}

impl WorkloadIdentityResult {
    pub fn valid(&self) -> bool {
        match self {
            Self::Issued { token, expires_at } => {
                let mut segments = token.split('.');
                *expires_at > 0
                    && !token.is_empty()
                    && token.len() <= 16_384
                    && segments.next().is_some_and(|segment| !segment.is_empty())
                    && segments.next().is_some_and(|segment| !segment.is_empty())
                    && segments.next().is_some_and(|segment| !segment.is_empty())
                    && segments.next().is_none()
                    && token.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')
                    })
            }
            Self::Signed { signature } => {
                !signature.is_empty()
                    && signature.len() <= 16_384
                    && signature.is_ascii()
                    && !signature.contains('\0')
            }
            Self::Credential { username, password } => {
                !username.is_empty()
                    && username.len() <= 128
                    && !username.contains(['\0', '\n', '\r'])
                    && !password.is_empty()
                    && password.len() <= 16_384
                    && !password.contains(['\0', '\n', '\r'])
            }
            Self::Unauthorized | Self::Unavailable => true,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum TerminalHeartbeat {
    Absent {
        #[serde(rename = "terminalVersion")]
        terminal_version: u8,
        terminal: &'static str,
    },
    Starting {
        #[serde(rename = "terminalVersion")]
        terminal_version: u8,
        terminal: &'static str,
        #[serde(rename = "residentGeneration")]
        resident_generation: TerminalGeneration,
        #[serde(rename = "foregroundCommand")]
        foreground_command: bool,
        #[serde(rename = "restartRequired")]
        restart_required: bool,
    },
    Ready {
        #[serde(rename = "terminalVersion")]
        terminal_version: u8,
        terminal: &'static str,
        #[serde(rename = "residentGeneration")]
        resident_generation: TerminalGeneration,
        #[serde(rename = "foregroundCommand")]
        foreground_command: bool,
        #[serde(rename = "restartRequired")]
        restart_required: bool,
    },
    Exited {
        #[serde(rename = "terminalVersion")]
        terminal_version: u8,
        terminal: &'static str,
        #[serde(rename = "residentGeneration")]
        resident_generation: TerminalGeneration,
        #[serde(rename = "foregroundCommand")]
        foreground_command: bool,
        #[serde(rename = "restartRequired")]
        restart_required: bool,
    },
    Failed {
        #[serde(rename = "terminalVersion")]
        terminal_version: u8,
        terminal: &'static str,
        #[serde(rename = "residentGeneration")]
        resident_generation: TerminalGeneration,
        #[serde(rename = "foregroundCommand")]
        foreground_command: bool,
        #[serde(rename = "restartRequired")]
        restart_required: bool,
    },
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ClientMessage<'a> {
    Register {
        generation: &'a str,
        #[serde(rename = "protocolMajor")]
        protocol_major: u8,
        release: &'static str,
        capabilities: Capabilities,
    },
    Heartbeat {
        generation: &'a str,
        terminal: TerminalHeartbeat,
    },
    ReadinessPong {
        generation: &'a str,
        #[serde(rename = "requestId")]
        request_id: &'a str,
    },
    ChangesCandidate {
        token: &'a str,
        outcome: &'a CandidateOutcome,
    },
    ChangesDirty,
    #[serde(rename = "workload-identity.request")]
    WorkloadIdentityRequest {
        generation: &'a str,
        #[serde(rename = "requestId")]
        request_id: &'a str,
        request: &'a WorkloadIdentityRequest,
    },
    Response {
        generation: &'a str,
        #[serde(rename = "requestId")]
        request_id: &'a str,
        result: OperationResult,
    },
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum OperationResult {
    Files(FilesResult),
    Environment(EnvironmentResult),
}

#[derive(Deserialize)]
#[serde(untagged)]
pub enum RequestOperation {
    Files(FilesOperation),
    Environment(EnvironmentOperation),
}

#[derive(Deserialize)]
#[serde(tag = "operation")]
pub enum EnvironmentOperation {
    #[serde(rename = "environment.activate")]
    Activate(EnvironmentActivate),
}

impl RequestOperation {
    pub fn refresh(&self) -> Option<crate::changes::RefreshRequest> {
        match self {
            Self::Files(operation) => operation.refresh(),
            Self::Environment(_) => None,
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum ServerMessage {
    #[serde(rename = "registered")]
    Registered {
        generation: String,
        #[serde(rename = "heartbeatIntervalMs")]
        heartbeat_interval_ms: u64,
        #[serde(rename = "heartbeatLeaseMs")]
        heartbeat_lease_ms: u64,
    },
    #[serde(rename = "heartbeat-ack")]
    HeartbeatAck { generation: String },
    #[serde(rename = "readiness-ping")]
    ReadinessPing {
        generation: String,
        #[serde(rename = "requestId")]
        request_id: String,
    },
    #[serde(rename = "changes-refresh")]
    ChangesRefresh {
        token: String,
        source: SourceContext,
        #[serde(rename = "expectedFingerprint")]
        expected_fingerprint: Option<String>,
    },
    #[serde(rename = "request")]
    Request {
        generation: String,
        #[serde(rename = "requestId")]
        request_id: String,
        operation: RequestOperation,
    },
    #[serde(rename = "workload-identity.response")]
    WorkloadIdentityResponse {
        generation: String,
        #[serde(rename = "requestId")]
        request_id: String,
        result: WorkloadIdentityResult,
    },
    #[serde(rename = "terminal.open")]
    TerminalOpen {
        #[serde(rename = "terminalVersion")]
        terminal_version: u8,
        terminal: String,
        mode: String,
        #[serde(rename = "expectedResidentGeneration")]
        expected_resident_generation: Option<TerminalGeneration>,
        dimensions: Dimensions,
    },
    #[serde(rename = "terminal.restart")]
    TerminalRestart {
        #[serde(rename = "terminalVersion")]
        terminal_version: u8,
        terminal: String,
        #[serde(rename = "expectedResidentGeneration")]
        expected_resident_generation: TerminalGeneration,
        dimensions: Dimensions,
    },
    #[serde(rename = "terminal.reset-attachments")]
    TerminalResetAttachments {
        #[serde(rename = "terminalVersion")]
        terminal_version: u8,
        terminal: String,
        #[serde(rename = "residentGeneration")]
        resident_generation: TerminalGeneration,
    },
    #[serde(rename = "terminal.attach")]
    TerminalAttach {
        #[serde(rename = "terminalVersion")]
        terminal_version: u8,
        terminal: String,
        #[serde(rename = "residentGeneration")]
        resident_generation: TerminalGeneration,
        #[serde(rename = "attachmentGeneration")]
        attachment_generation: TerminalGeneration,
        #[serde(rename = "resizeOrdinal")]
        resize_ordinal: U64String,
        dimensions: Dimensions,
    },
    #[serde(rename = "terminal.resize")]
    TerminalResize {
        #[serde(rename = "terminalVersion")]
        terminal_version: u8,
        terminal: String,
        #[serde(rename = "residentGeneration")]
        resident_generation: TerminalGeneration,
        #[serde(rename = "attachmentGeneration")]
        attachment_generation: TerminalGeneration,
        #[serde(rename = "resizeOrdinal")]
        resize_ordinal: U64String,
        dimensions: Dimensions,
    },
    #[serde(rename = "terminal.detach")]
    TerminalDetach {
        #[serde(rename = "terminalVersion")]
        terminal_version: u8,
        terminal: String,
        #[serde(rename = "residentGeneration")]
        resident_generation: TerminalGeneration,
        #[serde(rename = "attachmentGeneration")]
        attachment_generation: TerminalGeneration,
        reason: String,
    },
}

impl ServerMessage {
    pub fn request_operation(&self) -> Option<&RequestOperation> {
        match self {
            Self::Request { operation, .. } => Some(operation),
            _ => None,
        }
    }

    pub fn has_valid_conditional_fields(&self) -> bool {
        match self {
            Self::TerminalOpen {
                mode,
                expected_resident_generation,
                ..
            } => match mode.as_str() {
                "open-if-absent" => expected_resident_generation.is_none(),
                "restart-exited" => expected_resident_generation.is_some(),
                _ => false,
            },
            _ => true,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
pub enum TerminalClientMessage {
    #[serde(rename = "terminal.resident-state")]
    ResidentState {
        #[serde(rename = "terminalVersion")]
        terminal_version: u8,
        terminal: &'static str,
        #[serde(rename = "residentGeneration")]
        resident_generation: TerminalGeneration,
        state: &'static str,
        dimensions: Dimensions,
        #[serde(rename = "nextOutputSequence")]
        next_output_sequence: U64String,
        #[serde(rename = "foregroundCommand")]
        foreground_command: bool,
        #[serde(rename = "restartRequired")]
        restart_required: bool,
    },
    #[serde(rename = "terminal.replay-start")]
    ReplayStart {
        #[serde(rename = "terminalVersion")]
        terminal_version: u8,
        #[serde(rename = "residentGeneration")]
        resident_generation: TerminalGeneration,
        #[serde(rename = "attachmentGeneration")]
        attachment_generation: TerminalGeneration,
        #[serde(rename = "firstOutputSequence")]
        first_output_sequence: U64String,
        #[serde(rename = "throughOutputSequence")]
        through_output_sequence: U64String,
        #[serde(rename = "replayBytes")]
        replay_bytes: usize,
        truncated: bool,
    },
    #[serde(rename = "terminal.attachment-ready")]
    AttachmentReady {
        #[serde(rename = "terminalVersion")]
        terminal_version: u8,
        #[serde(rename = "residentGeneration")]
        resident_generation: TerminalGeneration,
        #[serde(rename = "attachmentGeneration")]
        attachment_generation: TerminalGeneration,
        #[serde(rename = "throughOutputSequence")]
        through_output_sequence: U64String,
        #[serde(rename = "dimensionsRevision")]
        dimensions_revision: U64String,
        dimensions: Dimensions,
    },
    #[serde(rename = "terminal.dimensions")]
    Dimensions {
        #[serde(rename = "terminalVersion")]
        terminal_version: u8,
        #[serde(rename = "residentGeneration")]
        resident_generation: TerminalGeneration,
        #[serde(rename = "resizeOrdinal")]
        resize_ordinal: U64String,
        #[serde(rename = "dimensionsRevision")]
        dimensions_revision: U64String,
        dimensions: Dimensions,
    },
    #[serde(rename = "terminal.detached")]
    Detached {
        #[serde(rename = "terminalVersion")]
        terminal_version: u8,
        #[serde(rename = "residentGeneration")]
        resident_generation: TerminalGeneration,
        #[serde(rename = "attachmentGeneration")]
        attachment_generation: TerminalGeneration,
    },
    #[serde(rename = "terminal.error")]
    Error {
        #[serde(rename = "terminalVersion")]
        terminal_version: u8,
        #[serde(rename = "residentGeneration")]
        resident_generation: TerminalGeneration,
        #[serde(
            rename = "attachmentGeneration",
            skip_serializing_if = "Option::is_none"
        )]
        attachment_generation: Option<TerminalGeneration>,
        code: &'static str,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalFrame {
    pub kind: u8,
    pub resident_generation: TerminalGeneration,
    pub attachment_generation: Option<TerminalGeneration>,
    pub sequence: u64,
    pub payload: Vec<u8>,
}

pub fn encode_terminal_frame(frame: &TerminalFrame) -> Result<Vec<u8>, ()> {
    if !(1..=3).contains(&frame.kind)
        || frame.payload.is_empty()
        || frame.payload.len() > TERMINAL_MAX_PAYLOAD_BYTES
        || (frame.kind == 3) != frame.attachment_generation.is_none()
        || frame.sequence == 0
    {
        return Err(());
    }
    let mut encoded = Vec::with_capacity(TERMINAL_HEADER_BYTES + frame.payload.len());
    encoded.extend_from_slice(b"DXT1");
    encoded.push(frame.kind);
    encoded.push(0);
    encoded.extend_from_slice(&frame.resident_generation.bytes());
    encoded.extend_from_slice(
        &frame
            .attachment_generation
            .map(TerminalGeneration::bytes)
            .unwrap_or([0_u8; 16]),
    );
    encoded.extend_from_slice(&frame.sequence.to_be_bytes());
    encoded.extend_from_slice(&(frame.payload.len() as u32).to_be_bytes());
    encoded.extend_from_slice(&frame.payload);
    Ok(encoded)
}

pub fn decode_terminal_frame(encoded: &[u8]) -> Result<TerminalFrame, ()> {
    if encoded.len() <= TERMINAL_HEADER_BYTES
        || encoded.len() > TERMINAL_MAX_FRAME_BYTES
        || &encoded[0..4] != b"DXT1"
        || !(1..=3).contains(&encoded[4])
        || encoded[5] != 0
    {
        return Err(());
    }
    let resident_bytes: [u8; 16] = encoded[6..22].try_into().map_err(|_| ())?;
    if resident_bytes.iter().all(|byte| *byte == 0) {
        return Err(());
    }
    let attachment_bytes: [u8; 16] = encoded[22..38].try_into().map_err(|_| ())?;
    let zero_attachment = attachment_bytes.iter().all(|byte| *byte == 0);
    if (encoded[4] == 3) != zero_attachment {
        return Err(());
    }
    let sequence = u64::from_be_bytes(encoded[38..46].try_into().map_err(|_| ())?);
    let payload_length = u32::from_be_bytes(encoded[46..50].try_into().map_err(|_| ())?) as usize;
    if sequence == 0 || payload_length != encoded.len() - TERMINAL_HEADER_BYTES {
        return Err(());
    }
    Ok(TerminalFrame {
        kind: encoded[4],
        resident_generation: TerminalGeneration(resident_bytes),
        attachment_generation: if zero_attachment {
            None
        } else {
            Some(TerminalGeneration(attachment_bytes))
        },
        sequence,
        payload: encoded[TERMINAL_HEADER_BYTES..].to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn generation(first: u8) -> TerminalGeneration {
        let mut bytes = [0_u8; 16];
        bytes[0] = first;
        TerminalGeneration(bytes)
    }

    #[test]
    fn generation_and_u64_json_are_canonical() {
        let value = generation(1);
        assert_eq!(
            serde_json::to_string(&value).unwrap(),
            r#""AQAAAAAAAAAAAAAAAAAAAA""#
        );
        assert_eq!(
            serde_json::from_str::<TerminalGeneration>(r#""AQAAAAAAAAAAAAAAAAAAAA""#).unwrap(),
            value
        );
        for invalid in [
            r#""AAAAAAAAAAAAAAAAAAAAAA""#,
            r#""AQAAAAAAAAAAAAAAAAAAA_""#,
            r#""AQAAAAAAAAAAAAAAAAAAA=""#,
        ] {
            assert!(serde_json::from_str::<TerminalGeneration>(invalid).is_err());
        }
        assert!(serde_json::from_str::<U64String>(r#""0""#).is_ok());
        assert!(serde_json::from_str::<U64String>(r#""01""#).is_err());
        assert!(serde_json::from_str::<U64String>(r#""18446744073709551616""#).is_err());
    }

    #[test]
    fn dxt1_round_trips_all_kinds_and_rejects_malformed_frames() {
        for kind in [1, 2, 3] {
            let frame = TerminalFrame {
                kind,
                resident_generation: generation(1),
                attachment_generation: (kind != 3).then(|| generation(2)),
                sequence: 42,
                payload: vec![1, 2, 3],
            };
            let encoded = encode_terminal_frame(&frame).unwrap();
            assert_eq!(encoded.len(), 53);
            assert_eq!(decode_terminal_frame(&encoded).unwrap(), frame);
        }
        let frame = TerminalFrame {
            kind: 1,
            resident_generation: generation(1),
            attachment_generation: Some(generation(2)),
            sequence: 1,
            payload: vec![1],
        };
        let valid = encode_terminal_frame(&frame).unwrap();
        for mutate in [0_usize, 5, 46] {
            let mut invalid = valid.clone();
            invalid[mutate] ^= 1;
            assert!(decode_terminal_frame(&invalid).is_err());
        }
        let mut invalid_attachment = valid.clone();
        invalid_attachment[22..38].fill(0);
        assert!(decode_terminal_frame(&invalid_attachment).is_err());
        assert!(decode_terminal_frame(&valid[..50]).is_err());
    }

    #[test]
    fn terminal_controls_are_strict() {
        let open = r#"{"terminalVersion":1,"type":"terminal.open","terminal":"default","mode":"open-if-absent","dimensions":{"columns":80,"rows":20}}"#;
        let open = serde_json::from_str::<ServerMessage>(open).unwrap();
        assert!(matches!(&open, ServerMessage::TerminalOpen { .. }));
        assert!(open.has_valid_conditional_fields());
        assert!(
            serde_json::from_str::<ServerMessage>(
                r#"{"terminalVersion":1,"type":"terminal.open","terminal":"default","mode":"open-if-absent","dimensions":{"columns":80,"rows":20},"extra":true}"#
            )
            .is_err()
        );
        let invalid_generation = r#"{"terminalVersion":1,"type":"terminal.attach","terminal":"default","residentGeneration":"AAAAAAAAAAAAAAAAAAAAAA","attachmentGeneration":"AgAAAAAAAAAAAAAAAAAAAA","resizeOrdinal":"1","dimensions":{"columns":80,"rows":20}}"#;
        assert!(serde_json::from_str::<ServerMessage>(invalid_generation).is_err());
        let restart = r#"{"terminalVersion":1,"type":"terminal.open","terminal":"default","mode":"restart-exited","expectedResidentGeneration":"AQAAAAAAAAAAAAAAAAAAAA","dimensions":{"columns":80,"rows":20}}"#;
        let restart = serde_json::from_str::<ServerMessage>(restart).unwrap();
        assert!(matches!(
            &restart,
            ServerMessage::TerminalOpen {
                expected_resident_generation: Some(_),
                ..
            }
        ));
        assert!(restart.has_valid_conditional_fields());
        for invalid in [
            r#"{"terminalVersion":1,"type":"terminal.open","terminal":"default","mode":"open-if-absent","expectedResidentGeneration":"AQAAAAAAAAAAAAAAAAAAAA","dimensions":{"columns":80,"rows":20}}"#,
            r#"{"terminalVersion":1,"type":"terminal.open","terminal":"default","mode":"restart-exited","dimensions":{"columns":80,"rows":20}}"#,
            r#"{"terminalVersion":1,"type":"terminal.open","terminal":"default","mode":"unknown","dimensions":{"columns":80,"rows":20}}"#,
        ] {
            assert!(
                !serde_json::from_str::<ServerMessage>(invalid)
                    .unwrap()
                    .has_valid_conditional_fields()
            );
        }
    }
}
