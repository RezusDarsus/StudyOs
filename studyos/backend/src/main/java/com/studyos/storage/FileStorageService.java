package com.studyos.storage;

import java.io.IOException;
import java.nio.file.Path;
import java.util.UUID;
import org.springframework.web.multipart.MultipartFile;

public interface FileStorageService {
    String save(UUID courseId, UUID documentId, MultipartFile file) throws IOException;
    String save(UUID courseId, UUID documentId, String filename, byte[] content) throws IOException;
    Path resolve(String path);
    void delete(String path) throws IOException;
}
