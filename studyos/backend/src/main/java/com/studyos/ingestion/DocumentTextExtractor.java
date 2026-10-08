package com.studyos.ingestion;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

public interface DocumentTextExtractor {
    ExtractedDocument extract(byte[] content);
    default ExtractedDocument extract(Path path) throws IOException { return extract(Files.readAllBytes(path)); }
}
