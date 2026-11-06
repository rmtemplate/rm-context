using System.Collections.Generic;
using System.Web.Http;

namespace Legacy.Controllers
{
    [RoutePrefix("api/books")]
    public class BooksController : ApiController
    {
        [Route("")]
        public IHttpActionResult GetAll() { return Ok(); }

        [Route("{id:int}")]
        [HttpGet]
        public IHttpActionResult Find(int id) { return Ok(); }

        [Route("~/api/authors/{authorId}/books")]
        public IHttpActionResult GetByAuthor(int authorId) { return Ok(); }

        [Route("")]
        public IHttpActionResult Post([FromBody] Book b) { return Ok(); }

        [Route("{id}/archive")]
        public IHttpActionResult Archive(int id) { return Ok(); }

        [AcceptVerbs("GET", "HEAD")]
        [Route("count")]
        public int Count() { return 0; }
    }

    public class ValuesController : ApiController
    {
        public IEnumerable<string> Get() { return new string[0]; }
        public string Get(int id) { return ""; }
        public void Delete(int id) { }
    }

    public class Book { public int Id { get; set; } }
}
