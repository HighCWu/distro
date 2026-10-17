// SPDX-License-Identifier: MIT
#include <algorithm>
#include <chrono>
#include <climits>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <stdexcept>
#include <string>
#include <vector>
#include <sys/stat.h>
#ifdef __wasm__
#include <sched.h>
#endif

namespace fs = std::filesystem;

static void require(bool value, const char *detail)
{
    if (!value) throw std::runtime_error(detail);
}

static void exercise(const fs::path &root)
{
    require(fs::create_directories(root / "sub"), "create directories");
    std::string payload(65539, '\0');
    for (std::size_t i = 0; i < payload.size(); ++i)
        payload[i] = static_cast<char>((i * 131 + 17) & 255);
    const auto source = root / "sub/payload.bin";
    {
        std::ofstream stream(source, std::ios::binary);
        stream.exceptions(std::ios::badbit | std::ios::failbit);
        stream.write(payload.data(), static_cast<std::streamsize>(payload.size()));
        stream.close();
    }
    require(fs::file_size(source) == payload.size(), "binary size");
    require(fs::copy_file(source, root / "copy.bin"), "copy file");
    std::error_code error;
    require(!fs::copy_file(source, root / "copy.bin", error) &&
            error == std::errc::file_exists, "existing destination error");
    require(fs::copy_file(source, root / "copy.bin", fs::copy_options::overwrite_existing),
            "overwrite existing copy");
    fs::rename(root / "copy.bin", root / "renamed.bin");
    require(!fs::exists(root / "copy.bin"), "rename removed old name");
    {
        std::ifstream stream(root / "renamed.bin", std::ios::binary);
        stream.exceptions(std::ios::badbit);
        require(stream.is_open(), "open copied file");
        const std::string copied{std::istreambuf_iterator<char>(stream), {}};
        require(copied == payload, "copied binary bytes");
    }
    fs::create_hard_link(root / "renamed.bin", root / "hard.bin");
    require(fs::equivalent(root / "hard.bin", root / "renamed.bin"), "hard link identity");
    fs::create_symlink("renamed.bin", root / "link");
    require(fs::read_symlink(root / "link") == "renamed.bin" &&
            fs::canonical(root / "link") == root / "renamed.bin", "symlink resolution");
    fs::create_symlink("missing", root / "dangling");
    require(!fs::exists(root / "dangling") && fs::is_symlink(fs::symlink_status(root / "dangling")),
            "dangling symlink status");
    const auto future = fs::file_time_type::clock::now() + std::chrono::seconds(3000000000LL);
    fs::last_write_time(root / "renamed.bin", future);
    require(fs::last_write_time(root / "renamed.bin") == future, "file clock round trip");
    struct stat metadata;
    require(stat((root / "renamed.bin").c_str(), &metadata) == 0 &&
            metadata.st_mtim.tv_sec > INT_MAX, "timestamp beyond signed time32");
    fs::permissions(root / "renamed.bin", fs::perms::owner_read | fs::perms::owner_write);
    require((fs::status(root / "renamed.bin").permissions() & fs::perms::mask) ==
            (fs::perms::owner_read | fs::perms::owner_write), "file permissions");
    std::vector<std::string> names;
    for (const auto &entry : fs::directory_iterator(root)) names.push_back(entry.path().filename().string());
    std::sort(names.begin(), names.end());
    require(names == std::vector<std::string>{"dangling", "hard.bin", "link", "renamed.bin", "sub"},
            "directory enumeration");
    error = std::make_error_code(std::errc::permission_denied);
    (void)fs::file_size(root / "missing", error);
    require(error == std::errc::no_such_file_or_directory, "error_code failure");
    try {
        (void)fs::file_size(root / "missing");
        throw std::runtime_error("missing filesystem_error");
    } catch (const fs::filesystem_error &failure) {
        require(failure.code() == std::errc::no_such_file_or_directory &&
                failure.path1() == root / "missing", "filesystem_error details");
    }
    require(fs::remove_all(root) == 7 && !fs::exists(root), "recursive cleanup");
}

int main()
{
    fs::path root;
    try {
#ifdef __wasm__
        fs::create_directories("/tmp");
#endif
        std::string pattern = (fs::temp_directory_path() / "sdk-filesystem-XXXXXX").string();
        char *created = mkdtemp(pattern.data());
        require(created != nullptr, "create temporary workspace");
        root = created;
        exercise(root);
        std::puts("C++ filesystem: binary copy, links, time64 metadata, directory iteration and errors verified");
        std::puts("::vm-test::pass");
        std::fflush(stdout);
#ifdef __wasm__
        for (;;) sched_yield();
#endif
        return EXIT_SUCCESS;
    } catch (const std::exception &failure) {
        if (!root.empty()) { std::error_code ignored; fs::remove_all(root, ignored); }
        std::printf("::vm-test::fail: C++ filesystem: %s\n", failure.what());
        std::fflush(stdout);
        return EXIT_FAILURE;
    }
}
