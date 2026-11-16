import datetime
import ipaddress

from cryptography import x509

from bridge.cert import ensure_cert


def _load(path):
    return x509.load_pem_x509_certificate(path.read_bytes())


def test_ensure_cert_creates_with_san(tmp_path):
    cert_path, key_path = ensure_cert(tmp_path, ["192.168.0.10"])

    cert = _load(cert_path)
    san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    assert ipaddress.ip_address("192.168.0.10") in san.get_values_for_type(x509.IPAddress)
    assert ipaddress.ip_address("127.0.0.1") in san.get_values_for_type(x509.IPAddress)
    assert "localhost" in san.get_values_for_type(x509.DNSName)
    lifetime = cert.not_valid_after_utc - datetime.datetime.now(datetime.timezone.utc)
    assert lifetime > datetime.timedelta(days=9 * 365)
    assert key_path.read_bytes().startswith(b"-----BEGIN")


def test_ensure_cert_is_stable(tmp_path):
    cert_path, key_path = ensure_cert(tmp_path, ["192.168.0.10"])
    before = (cert_path.read_bytes(), key_path.read_bytes())

    ensure_cert(tmp_path, ["192.168.0.10"])

    assert (cert_path.read_bytes(), key_path.read_bytes()) == before
