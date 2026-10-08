package com.studyos.storage;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

@Service
public class LocalFileStorageService implements FileStorageService {
    private final Path root;

    public LocalFileStorageService(@Value("${studyos.storage-root:./data/uploads}") String root) {
        this.root = Path.of(root).toAbsolutePath().normalize();
    }

    @Override
    public String save(UUID courseId, UUID documentId, MultipartFile file) throws IOException {
        String original = file.getOriginalFilename() == null ? "document.pdf" : file.getOriginalFilename();
        Path destination = destination(courseId, documentId, original);
        file.transferTo(destination);
        return destination.toString();
    }

    @Override
    public String save(UUID courseId, UUID documentId, String filename, byte[] content) throws IOException {
        Path destination = destination(courseId, documentId, filename);
        Files.write(destination, content, StandardOpenOption.CREATE_NEW);
        return destination.toString();
    }

    private Path destination(UUID courseId, UUID documentId, String filename) throws IOException {
        Path workspaceRoot = root.resolve(courseId.toString()).normalize();
        Files.createDirectories(workspaceRoot);
        String original = Path.of(filename == null || filename.isBlank() ? "source.txt" : filename).getFileName().toString();
        Path destination = workspaceRoot.resolve(documentId + "-" + original).normalize();
        if (!destination.startsWith(workspaceRoot)) throw new IOException("Invalid document filename");
        return destination;
    }

    @Override public Path resolve(String path) { return Path.of(path).toAbsolutePath().normalize(); }
    @Override public void delete(String path) throws IOException { Files.deleteIfExists(resolve(path)); }
}
